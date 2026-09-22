"""Extractor service: crawl a module's page and fill in its extracted_data."""

import json
import logging
import re
from collections import defaultdict

from crawl4ai import LLMConfig
from crawl4ai.extraction_strategy import LLMExtractionStrategy

from src.config import LLMProviderName, Settings
from src.exceptions import CrawlerError, ExtractorError
from src.extractor.crawler import Crawler
from src.extractor.records import (
    CrawlExtraction,
    ExtractedRecord,
    parse_records,
    to_extracted_data,
)
from src.extractor.replay import replay
from src.llm.protocol import LLMProvider
from src.model.test_case import ExecutionStep, ExtractedData, Module
from src.prompt_loader import render_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."


class Extractor:
    """Crawls a module's page and selects the identifiers each step needs."""

    def __init__(self, llm: LLMProvider, settings: Settings, crawler: Crawler) -> None:
        """Initialize with the LLM provider, settings, and crawler to use.

        Args:
            llm: Used only when `settings.llm_provider` is `mock`.
            settings: Builds the Crawl4AI `LLMConfig` for real providers.
            crawler: Fetches (and, for real providers, extracts from) the page.
        """
        self._llm = llm
        self._settings = settings
        self._crawler = crawler
        if settings.llm_provider is LLMProviderName.MOCK:
            self._llm_config = None
        elif settings.llm_provider is LLMProviderName.AZURE_OPENAI:
            self._llm_config = LLMConfig(
                provider=f"azure/{settings.azure_deployment_name}",
                api_token=settings.azure_openai_api_key,
                base_url=settings.azure_openai_endpoint,
            )
        elif settings.llm_provider is LLMProviderName.OPENAI:
            self._llm_config = LLMConfig(
                provider=f"openai/{settings.openai_model}",
                api_token=settings.openai_api_key,
            )
        else:
            self._llm_config = LLMConfig(
                provider=f"anthropic/{settings.anthropic_model}",
                api_token=settings.anthropic_api_key,
            )

    def run(
        self, module: Module, *, feedback: str | None = None
    ) -> tuple[Module, list[str]]:
        """Crawl `module`'s page and extract element identifiers for each step.

        Args:
            module: The module to extract element identifiers for.
            feedback: Retry feedback from a previous failed validation, if any.

        Returns:
            The module with extracted_data filled in, and the HTML each
            step's identifiers came from (one entry per step).

        Raises:
            CrawlerError: If the module's page cannot be crawled.
            ExtractorError: If extraction fails or doesn't match the
                expected shape.
        """
        logger.info(
            "Extracting element data for %s (%d step(s))",
            module.url,
            len(module.execution_steps),
        )

        keywords = _keywords_for(module)
        feedback_section = (
            ""
            if not feedback
            else f"\n\nPREVIOUS ATTEMPT FEEDBACK (fix these issues and try again):"
            f"\n{feedback}\n"
        )

        instruction = render_prompt(
            "extractor",
            numbered_steps="\n".join(
                f"{index}. {step.step}"
                for index, step in enumerate(module.execution_steps)
            ),
            feedback_section=feedback_section,
        )
        extraction = self._crawl_and_extract(
            module.url, instruction, keywords, js_code=None
        )
        result_module = _reassemble(module, parse_records(extraction.records))
        html_by_step = [extraction.html] * len(module.execution_steps)

        result_module, html_by_step = replay(
            result_module,
            html_by_step,
            keywords,
            feedback_section,
            self._crawl_and_extract,
        )

        element_count = sum(
            len(step.extracted_data) for step in result_module.execution_steps
        )
        logger.info(
            "Extracted %d element identifier(s) for %s", element_count, module.url
        )
        return result_module, html_by_step

    def _crawl_and_extract(
        self,
        url: str,
        instruction: str,
        keywords: frozenset[str],
        js_code: list[str] | None,
    ) -> CrawlExtraction:
        """Crawl `url` and run extraction, via mock or real provider."""
        if self._llm_config is None:  # Run with mock provider
            crawl = self._crawler.run(url, js_code=js_code, keywords=keywords)
            if not crawl.success:
                raise CrawlerError(f"Could not crawl {url}: {crawl.error_message}")

            user_prompt = f"{instruction}\n\nPage HTML:\n{crawl.html}"
            response = self._llm.complete(
                system_prompt=_SYSTEM_PROMPT, user_prompt=user_prompt, json_mode=True
            )
            logger.debug("Raw LLM response (%d chars): %s", len(response), response)
            records = _parse_json(response, "LLM response")
            return CrawlExtraction(records=records, html=crawl.html, js_ok=crawl.js_ok)

        return self._run_llm_extraction(url, instruction, keywords, js_code)

    def _run_llm_extraction(
        self,
        url: str,
        instruction: str,
        keywords: frozenset[str],
        js_code: list[str] | None,
    ) -> CrawlExtraction:
        """Crawl and extract in one Crawl4AI call via LLMExtractionStrategy."""
        strategy = LLMExtractionStrategy(
            llm_config=self._llm_config,
            schema=ExtractedRecord.model_json_schema(),
            extraction_type="schema",
            instruction=instruction,
            input_format="cleaned_html",
            extra_args=self._extra_args(),
        )
        crawl = self._crawler.run(
            url, extraction_strategy=strategy, js_code=js_code, keywords=keywords
        )
        if not crawl.success:
            raise CrawlerError(f"Could not crawl {url}: {crawl.error_message}")

        items = _parse_json(crawl.extracted_content or "[]", "LLM extraction result")

        errors = [item for item in items if item.get("error")]
        if errors:
            raise ExtractorError(f"LLM extraction failed: {errors[0]}")
        return CrawlExtraction(records=items, html=crawl.html, js_ok=crawl.js_ok)

    def _extra_args(self) -> dict[str, float | str]:
        """Return extra completion kwargs, including provider-specific ones."""
        args: dict[str, float | str] = {"temperature": 0.0}
        if self._settings.llm_provider is LLMProviderName.AZURE_OPENAI:
            args["api_version"] = self._settings.openai_api_version or ""
        return args


def _parse_json(text: str, context: str) -> list[dict]:
    """Parse `text` as JSON, or raise ExtractorError naming `context`."""
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ExtractorError(f"{context} was not valid JSON: {exc}") from exc


def _keywords_for(module: Module) -> frozenset[str]:
    """Return lowercased alphanumeric tokens from `module`'s description/steps.

    Used as the scraper's last-resort trimming relevance signal.
    """
    step_texts = (step.step for step in module.execution_steps)
    text = " ".join([module.description, *step_texts])
    return frozenset(re.findall(r"[a-z0-9]+", text.lower()))


def _reassemble(module: Module, records: list[ExtractedRecord]) -> Module:
    """Rebuild `module` with `records` grouped back onto their steps by step_index.

    Records with an out-of-range step_index are dropped and logged.
    """
    grouped: dict[int, list[ExtractedData]] = defaultdict(list)
    skipped = 0
    for record in records:
        if not 0 <= record.step_index < len(module.execution_steps):
            skipped += 1
            continue
        grouped[record.step_index].append(to_extracted_data(record))
    if skipped:
        logger.warning(
            "Dropped %d extracted record(s) with an out-of-range step_index",
            skipped,
        )

    new_steps = [
        ExecutionStep(step=step.step, extracted_data=grouped.get(index, []))
        for index, step in enumerate(module.execution_steps)
    ]
    return Module(
        url=module.url, description=module.description, execution_steps=new_steps
    )
