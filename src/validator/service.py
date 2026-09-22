"""Validator service: verify extracted element identifiers against page HTML."""

import json
import logging

from pydantic import BaseModel, Field, ValidationError

from src.exceptions import ValidatorError
from src.llm.protocol import LLMProvider
from src.model.test_case import ExtractedData, Module
from src.prompt_loader import render_prompt
from src.validator.uniqueness import count_dom_matches, element_type_is_plausible

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."


class IdentifierVerdict(BaseModel):
    """Validation outcome for a single extracted identifier."""

    identifier_tracking: str
    is_valid: bool
    reason: str


class ValidationResult(BaseModel):
    """Aggregate validation outcome for one module's extracted data."""

    verdicts: list[IdentifierVerdict] = Field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        """Whether every extracted identifier validated successfully."""
        return all(verdict.is_valid for verdict in self.verdicts)

    @property
    def feedback(self) -> str:
        """Feedback listing every failed identifier's reason, for a retry.

        Empty when every identifier validated successfully.
        """
        failures = [verdict for verdict in self.verdicts if not verdict.is_valid]
        return "\n".join(f"- {v.identifier_tracking}: {v.reason}" for v in failures)


class Validator:
    """Verifies extracted element identifiers against the crawled HTML."""

    def __init__(self, llm: LLMProvider) -> None:
        """Initialize with the LLM provider to use.

        Args:
            llm: The LLM provider used to perform the validation.
        """
        self._llm = llm

    def run(self, module: Module, html_by_step: list[str]) -> ValidationResult:
        """Validate every extracted identifier in `module` against its HTML.

        Args:
            module: The module, already augmented with extracted identifiers
                by the Extractor.
            html_by_step: The HTML each step's identifiers were extracted
                from, one entry per step (usually all the same snapshot).

        Returns:
            One verdict per extracted identifier. A module with none
            validates trivially, with no LLM call made.

        Raises:
            ValidatorError: If the LLM response isn't valid JSON, doesn't
                match the expected shape, or has the wrong number of verdicts.
        """
        indexed_identifiers = _flatten_identifiers(module)
        if not indexed_identifiers:
            logger.info("No extracted data to validate for %s", module.url)
            return ValidationResult()

        logger.info(
            "Validating %d extracted identifier(s) for %s",
            len(indexed_identifiers),
            module.url,
        )
        prompt = render_prompt(
            "validator",
            module_json=module.model_dump_json(indent=2),
            html=_render_html_sections(html_by_step),
        )
        response = self._llm.complete(
            system_prompt=_SYSTEM_PROMPT, user_prompt=prompt, json_mode=True
        )
        logger.debug("Raw LLM response (%d chars): %s", len(response), response)

        try:
            data = json.loads(response)
        except json.JSONDecodeError as exc:
            raise ValidatorError(f"LLM response was not valid JSON: {exc}") from exc

        try:
            result = ValidationResult.model_validate(data)
        except ValidationError as exc:
            raise ValidatorError(
                f"LLM response did not match the ValidationResult shape: {exc}"
            ) from exc

        if len(result.verdicts) != len(indexed_identifiers):
            raise ValidatorError(
                f"LLM returned {len(result.verdicts)} verdict(s) but module "
                f"has {len(indexed_identifiers)} extracted identifier(s)"
            )
        result = _apply_deterministic_vetoes(result, indexed_identifiers, html_by_step)

        logger.info(
            "Validation for %s: %s (%d verdict(s))",
            module.url,
            "passed" if result.is_valid else "failed",
            len(result.verdicts),
        )
        return result


def _flatten_identifiers(module: Module) -> list[tuple[int, ExtractedData]]:
    """Return every extracted identifier in `module`, paired with its step index."""
    return [
        (step_index, data)
        for step_index, step in enumerate(module.execution_steps)
        for data in step.extracted_data
    ]


def _render_html_sections(html_by_step: list[str]) -> str:
    """Render `html_by_step` for the validator prompt's single `{html}` slot.

    Collapses to the one snapshot when every step used the same HTML;
    otherwise labels and concatenates each distinct snapshot.
    """
    distinct = list(dict.fromkeys(html_by_step))
    if len(distinct) == 1:
        return distinct[0]
    return "\n\n".join(
        f"<!-- Page HTML snapshot {index} -->\n{html}"
        for index, html in enumerate(distinct)
    )


def _apply_deterministic_vetoes(
    result: ValidationResult,
    indexed_identifiers: list[tuple[int, ExtractedData]],
    html_by_step: list[str],
) -> ValidationResult:
    """Veto any LLM-approved verdict that fails a deterministic DOM check.

    Two checks against the identifier's own HTML: uniqueness (exactly 1
    match), then -- only if unique -- whether the element's tag/role
    plausibly matches its claimed `ElementType`. Both only flip valid ->
    invalid, never the reverse. Also re-keys each verdict's
    `identifier_tracking` to the module's ground truth, since matching here
    is positional, not by the LLM's echoed string.
    """
    verdicts = []
    for (step_index, identifier), verdict in zip(
        indexed_identifiers, result.verdicts, strict=True
    ):
        html = html_by_step[step_index]
        updates = {"identifier_tracking": identifier.identifier_tracking}
        if verdict.is_valid:
            count = count_dom_matches(
                html, identifier.identifier_type, identifier.identifier_tracking
            )
            if count == 0:
                updates["is_valid"] = False
                updates["reason"] = (
                    "resolves to 0 elements in the page HTML (expected "
                    "exactly 1); pick a different selector or attribute"
                )
            elif count > 1:
                updates["is_valid"] = False
                updates["reason"] = (
                    f"resolves to {count} elements in the page HTML "
                    "(expected exactly 1); choose a selector unique to a "
                    "single element, or leave this step's extracted_data "
                    "empty if none exists"
                )
            elif not element_type_is_plausible(
                html,
                identifier.identifier_type,
                identifier.identifier_tracking,
                identifier.type,
            ):
                updates["is_valid"] = False
                updates["reason"] = (
                    "resolves to an element whose tag/role doesn't match "
                    f"its claimed type '{identifier.type}'"
                )
        verdicts.append(verdict.model_copy(update=updates))
    return ValidationResult(verdicts=verdicts)
