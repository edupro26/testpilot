"""Crawler: fetch a page via Crawl4AI, optionally extracting from it."""

import asyncio
import logging

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.extraction_strategy import LLMExtractionStrategy
from pydantic import BaseModel

from src.exceptions import CrawlerError
from src.extractor.scraping import AttributePreservingScraper

logger = logging.getLogger(__name__)

_BOILERPLATE_TAGS = [
    "script",
    "style",
    "noscript",
    "svg",
    "iframe",
    "link",
    "meta",
    "footer",
]


class CrawlResult(BaseModel):
    """The outcome of crawling a single public page."""

    url: str
    success: bool
    html: str = ""
    error_message: str = ""
    extracted_content: str | None = None
    js_ok: bool = True


class Crawler:
    """Fetches a public, non-authenticated page, optionally extracting from it."""

    def run(
        self,
        url: str,
        extraction_strategy: LLMExtractionStrategy | None = None,
        js_code: list[str] | None = None,
        keywords: frozenset[str] | None = None,
    ) -> CrawlResult:
        """Crawls a `url` and extracts relevant html elements.

        Args:
            url: The public page URL to crawl.
            extraction_strategy: An LLM-based extraction strategy.
            js_code: JavaScript snippets to execute before HTML capture.
            keywords: Relevance signal for the scraper's last-resort trimming.

        Returns:
            Cleaned HTML in `html`, and if `extraction_strategy` succeeded
            its raw JSON in `extracted_content`. A failed load is reported
            via `success = False`, not raised.

        Raises:
            CrawlerError: If the crawl itself could not be executed.
        """
        logger.info("Crawling %s", url)
        try:
            result = asyncio.run(
                self._crawl(url, extraction_strategy, js_code, keywords)
            )
        except Exception as exc:
            raise CrawlerError(f"Failed to crawl {url}: {exc}") from exc

        if result.success:
            logger.info("Crawled %s (%d chars of HTML)", url, len(result.html))
        else:
            logger.warning("Crawl of %s failed: %s", url, result.error_message)
        return result

    async def _crawl(
        self,
        url: str,
        extraction_strategy: LLMExtractionStrategy | None,
        js_code: list[str] | None,
        keywords: frozenset[str] | None,
    ) -> CrawlResult:
        """Run the actual Crawl4AI crawl and adapt its result."""
        config = _get_crawler_config(extraction_strategy, js_code, keywords)
        async with AsyncWebCrawler(config=_get_browser_config()) as crawler:
            page = await crawler.arun(url, config=config)

        html = (page.cleaned_html or "") if page.success else ""

        return CrawlResult(
            url=url,
            success=page.success,
            html=html,
            error_message="" if page.success else (page.error_message or ""),
            extracted_content=page.extracted_content if page.success else None,
            js_ok=_js_ok(page.js_execution_result),
        )


def _get_browser_config() -> BrowserConfig:
    """Return the headless browser configuration used for every crawl."""
    return BrowserConfig(headless=True, verbose=False)


def _get_crawler_config(
    extraction_strategy: LLMExtractionStrategy | None = None,
    js_code: list[str] | None = None,
    keywords: frozenset[str] | None = None,
) -> CrawlerRunConfig:
    """Return the crawl run configuration used for locator extraction."""
    # Disable chunking for safe LLM extraction
    if extraction_strategy is not None:
        extraction_strategy.apply_chunking = False
        extraction_strategy.chunk_token_threshold = 1e9

    return CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        wait_until="domcontentloaded",
        page_timeout=30_000,
        remove_overlay_elements=True,
        exclude_all_images=True,
        excluded_tags=_BOILERPLATE_TAGS,
        scraping_strategy=AttributePreservingScraper(keywords or frozenset()),
        extraction_strategy=extraction_strategy,
        js_code=js_code,
    )


def _js_ok(js_execution_result: dict | None) -> bool:
    """Return whether every script in a `js_code` run succeeded."""
    if js_execution_result is None:
        return True
    if not js_execution_result.get("success", True):
        return False
    return all(
        result.get("success", True) for result in js_execution_result.get("results", [])
    )
