"""Extractor service: fill in a module's extracted_data from its page HTML."""

import json
import logging

from pydantic import ValidationError

from src.exceptions import ExtractorError
from src.llm.protocol import LLMProvider
from src.model.test_case import Module
from src.prompt_loader import render_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."


class Extractor:
    """Selects the UI element identifiers each execution step needs."""

    def __init__(self, llm: LLMProvider) -> None:
        """Initialize with the LLM provider to use.

        Args:
            llm: The LLM provider used to perform the extraction.
        """
        self._llm = llm

    def run(self, module: Module, html: str, *, feedback: str | None = None) -> Module:
        """Extract element identifiers for every step of `module`.

        Args:
            module: The module (url, description, execution steps) to
                extract element identifiers for. Its steps' extracted_data
                is empty when coming straight from the Structurer.
            html: The module's page, as crawled by the Crawler.
            feedback: Validator feedback from a previous failed attempt, if
                any, appended to the prompt to correct the retry.

        Returns:
            The module with extracted_data filled in for each step.

        Raises:
            ExtractorError: If the LLM response is not valid JSON or does
                not match the expected Module shape.
        """
        logger.info(
            "Extracting element data for %s (%d step(s))",
            module.url,
            len(module.execution_steps),
        )

        feedback_section = (
            "\n\nPREVIOUS ATTEMPT FEEDBACK (fix these issues and try again):"
            f"\n{feedback}\n"
            if feedback
            else ""
        )
        prompt = render_prompt(
            "extractor",
            module_json=module.model_dump_json(indent=2),
            html=html,
            feedback_section=feedback_section,
        )
        response = self._llm.complete(
            system_prompt=_SYSTEM_PROMPT, user_prompt=prompt, json_mode=True
        )
        logger.debug("Raw LLM response (%d chars): %s", len(response), response)

        try:
            data = json.loads(response)
        except json.JSONDecodeError as exc:
            raise ExtractorError(f"LLM response was not valid JSON: {exc}") from exc

        try:
            extracted_model = Module.model_validate(data)
        except ValidationError as exc:
            raise ExtractorError(
                f"LLM response did not match the Module shape: {exc}"
            ) from exc

        element_count = sum(
            len(step.extracted_data) for step in extracted_model.execution_steps
        )
        logger.info(
            "Extracted %d element identifier(s) for %s", element_count, module.url
        )
        return extracted_model
