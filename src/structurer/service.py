"""Structurer service: markdown test case -> Level 1 TestCase."""

import json
import logging

from pydantic import ValidationError

from src.exceptions import StructurerError
from src.llm.protocol import LLMProvider
from src.model.test_case import TestCase
from src.prompt_loader import render_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."


class Structurer:
    """Converts a markdown test case specification into a TestCase."""

    def __init__(self, llm: LLMProvider) -> None:
        """Initialize with the LLM provider to use.

        Args:
            llm: The LLM provider used to perform the conversion.
        """
        self._llm = llm

    def run(self, markdown: str) -> TestCase:
        """Convert a markdown test case specification into a TestCase.

        Args:
            markdown: The raw test case specification.

        Returns:
            The parsed and validated TestCase.

        Raises:
            StructurerError: If the LLM response is not valid JSON or does
                not match the expected TestCase shape.
        """
        logger.info("Structuring test case (%d chars of markdown)", len(markdown))

        prompt = render_prompt("structurer", test_case_markdown=markdown)
        response = self._llm.complete(
            system_prompt=_SYSTEM_PROMPT, user_prompt=prompt, json_mode=True
        )
        logger.debug("Raw LLM response (%d chars): %s", len(response), response)

        try:
            data = json.loads(response)
        except json.JSONDecodeError as exc:
            raise StructurerError(f"LLM response was not valid JSON: {exc}") from exc

        try:
            test_case = TestCase.model_validate(data)
        except ValidationError as exc:
            raise StructurerError(
                f"LLM response did not match the TestCase shape: {exc}"
            ) from exc

        logger.info(
            "Structured %r into %d module(s)", test_case.name, len(test_case.modules)
        )
        return test_case
