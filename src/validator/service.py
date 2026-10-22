"""Validator service: prove a step's statements, then judge what they test.

1. Replay (deterministic): does the code run against a live page?
2. Semantic (one LLM call): does it test what the step asked?
"""

import json
import logging

from pydantic import BaseModel, Field, ValidationError

from src.exceptions import ValidatorError
from src.llm.protocol import LLMProvider
from src.model.test_case import StepStatement
from src.prompt_loader import render_prompt
from src.validator.browser import BrowserError, ValidationBrowser

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."


class StepVerdict(BaseModel):
    """The outcome of validating one execution step.

    `statements` are the accepted statements with their `reason` filled in;
    empty when the step is rejected.
    """

    is_valid: bool
    reason: str = ""
    statements: list[StepStatement] = Field(default_factory=list)

    @property
    def feedback(self) -> str:
        """Why the step was rejected, for the Extractor's retry."""
        return "" if self.is_valid else self.reason


class _SemanticVerdict(BaseModel):
    """The semantic check's JSON reply."""

    is_valid: bool
    reason: str = ""
    statement_reasons: list[str] = Field(default_factory=list)


class Validator:
    """Proves a step's statements against a live page, then judges them."""

    def __init__(self, llm: LLMProvider, browser: ValidationBrowser) -> None:
        """Initialize with the LLM provider and validation browser to use.

        Args:
            llm: Performs the semantic judgement.
            browser: The cumulative validation browser, shared across the run.
        """
        self._llm = llm
        self._browser = browser

    def run(self, step: str, statements: list[StepStatement]) -> StepVerdict:
        """Validate one step's statements.

        Args:
            step: The execution step's text.
            statements: The statements collected for it.

        Returns:
            The verdict. A step with no statements is trivially valid.

        Raises:
            ValidatorError: If the LLM response is not valid JSON or does
                not match the expected shape.
        """
        if not statements:
            logger.info("Step has no statements to validate")
            return StepVerdict(is_valid=True, reason="no browser interaction needed")

        logger.info("Replaying %d statement(s)", len(statements))
        try:
            self._browser.run(statements)
        except BrowserError as failure:
            logger.warning("Replay failed: %s", failure.code)
            preceding = (
                ""
                if not failure.ran
                else (
                    "\nThese statements ran first, without error:\n"
                    + "\n".join(failure.ran)
                    + "\n"
                )
            )
            return StepVerdict(
                is_valid=False,
                reason=(
                    f"This statement failed when replayed in a clean browser:\n"
                    f"{failure.code}\n{failure.reason}\n{preceding}"
                ),
            )

        return self._judge(step, statements)

    def _judge(self, step: str, statements: list[StepStatement]) -> StepVerdict:
        """Ask the LLM whether the proven code does what the step asked."""
        prompt = render_prompt(
            "validator",
            step=step,
            code=_number(statements),
            page_url=self._browser.page.url,
            page_title=self._browser.page.title(),
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
            semantic = _SemanticVerdict.model_validate(data)
        except ValidationError as exc:
            raise ValidatorError(
                f"LLM response did not match the verdict shape: {exc}"
            ) from exc

        logger.info(
            "Semantic check: %s%s",
            "passed" if semantic.is_valid else "failed",
            "" if semantic.is_valid else f" ({semantic.reason})",
        )
        if not semantic.is_valid:
            return StepVerdict(is_valid=False, reason=semantic.reason)

        reasons = semantic.statement_reasons
        if len(reasons) != len(statements):
            logger.warning(
                "Got %d statement reason(s) for %d statement(s), using the "
                "step's reason for each",
                len(reasons),
                len(statements),
            )
            reasons = [semantic.reason] * len(statements)
        return StepVerdict(
            is_valid=True,
            reason=semantic.reason,
            statements=[
                statement.model_copy(update={"reason": reason})
                for statement, reason in zip(statements, reasons, strict=True)
            ],
        )


def _number(statements: list[StepStatement]) -> str:
    """Render `statements` as a numbered list, one line per statement."""
    return "\n".join(
        f"{number}. {statement.code}"
        for number, statement in enumerate(statements, start=1)
    )
