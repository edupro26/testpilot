"""Validator service: verify extracted element identifiers against page HTML."""

import json
import logging

from pydantic import BaseModel, Field, ValidationError

from src.exceptions import ValidatorError
from src.llm.protocol import LLMProvider
from src.model.test_case import Module
from src.prompt_loader import render_prompt

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

    def run(self, module: Module, html: str) -> ValidationResult:
        """Validate every extracted identifier in `module` against `html`.

        Args:
            module: The module, already augmented with extracted element
                identifiers by the Extractor.
            html: The module's page, as crawled by the Crawler.

        Returns:
            The validation outcome, with one verdict per extracted
            identifier. A module with no extracted identifiers validates
            trivially, with no LLM call made.

        Raises:
            ValidatorError: If the LLM response is not valid JSON or does
                not match the expected ValidationResult shape.
        """
        identifier_count = sum(
            len(step.extracted_data) for step in module.execution_steps
        )
        if identifier_count == 0:
            logger.info("No extracted data to validate for %s", module.url)
            return ValidationResult()

        logger.info(
            "Validating %d extracted identifier(s) for %s",
            identifier_count,
            module.url,
        )
        prompt = render_prompt(
            "validator", module_json=module.model_dump_json(indent=2), html=html
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

        logger.info(
            "Validation for %s: %s (%d verdict(s))",
            module.url,
            "passed" if result.is_valid else "failed",
            len(result.verdicts),
        )
        return result
