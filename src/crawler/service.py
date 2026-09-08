"""Crawler service: fetch a page's cleaned HTML via Crawl4AI."""

import asyncio
import logging

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from pydantic import BaseModel

from src.exceptions import CrawlerError

logger = logging.getLogger(__name__)


class CrawlResult(BaseModel):
    """The outcome of crawling a single public page."""

    url: str
    success: bool
    html: str = ""
    error_message: str = ""


_PAGE_TIMEOUT_MS = 30_000

# `remove_overlay_elements` is a best-effort heuristic: how much it strips
# varies run-to-run with what happens to be rendered (e.g. a promo modal
# present on one crawl and absent on the next), observed anywhere from ~2K
# to ~260K chars of cleaned HTML for the same page. This is a hard backstop
# on prompt size/cost regardless of how that heuristic behaves.
_MAX_HTML_CHARS = 100_000

# Boilerplate tags that never carry test-relevant elements. `footer` is
# included because site-wide footers (sitemaps, social links, newsletter
# forms) are consistently irrelevant to a test case's steps in practice,
# and dropping it removes most of a typical page's noise.
_EXCLUDED_TAGS = [
    "script",
    "style",
    "noscript",
    "svg",
    "iframe",
    "link",
    "meta",
    "footer",
]


def _browser_config() -> BrowserConfig:
    """Return the headless browser configuration used for every crawl."""
    return BrowserConfig(headless=True, verbose=False)


def _run_config() -> CrawlerRunConfig:
    """Return the crawl run configuration tuned for locator extraction.

    `keep_data_attributes=True` preserves `data-*` attributes (e.g.
    `data-testid`), which are often the most stable element locators.
    `remove_overlay_elements` and `exclude_all_images` strip cookie
    banners/modals and image payloads that otherwise dominate page size
    without ever containing a useful locator.
    """
    return CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        wait_until="domcontentloaded",
        page_timeout=_PAGE_TIMEOUT_MS,
        keep_data_attributes=True,
        excluded_tags=_EXCLUDED_TAGS,
        remove_overlay_elements=True,
        exclude_all_images=True,
    )


class Crawler:
    """Fetches a public, non-authenticated page's cleaned HTML."""

    def run(self, url: str) -> CrawlResult:
        """Crawl `url` and return its cleaned HTML.

        Args:
            url: The public page URL to crawl.

        Returns:
            The crawl outcome. A reachable page that fails to load (e.g. a
            404 or timeout) is reported via `CrawlResult.success = False`,
            not by raising.

        Raises:
            CrawlerError: If the crawl itself could not be executed (e.g.
                the browser failed to launch).
        """
        logger.info("Crawling %s", url)
        try:
            result = asyncio.run(self._crawl(url))
        except Exception as exc:
            raise CrawlerError(f"Failed to crawl {url}: {exc}") from exc

        if result.success:
            logger.info("Crawled %s (%d chars of HTML)", url, len(result.html))
        else:
            logger.warning("Crawl of %s failed: %s", url, result.error_message)
        return result

    async def _crawl(self, url: str) -> CrawlResult:
        """Run the actual Crawl4AI crawl and adapt its result."""
        async with AsyncWebCrawler(config=_browser_config()) as crawler:
            page = await crawler.arun(url, config=_run_config())

        html = (page.cleaned_html or "") if page.success else ""
        if len(html) > _MAX_HTML_CHARS:
            logger.warning(
                "Cleaned HTML for %s was %d chars, truncating to %d",
                url,
                len(html),
                _MAX_HTML_CHARS,
            )
            html = html[:_MAX_HTML_CHARS]

        return CrawlResult(
            url=url,
            success=page.success,
            html=html,
            error_message="" if page.success else (page.error_message or ""),
        )
