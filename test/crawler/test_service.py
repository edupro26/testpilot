"""Tests for src.crawler.service."""

from unittest.mock import MagicMock

import pytest
from crawl4ai import AsyncWebCrawler
from pytest_mock import MockerFixture
from src.crawler.service import _MAX_HTML_CHARS, Crawler
from src.exceptions import CrawlerError


def _mock_crawler(mocker: MockerFixture) -> MagicMock:
    """Patch AsyncWebCrawler with a mock usable as `async with ... as x`.

    Specced against the real class so `.arun` (a coroutine method) is
    auto-detected as an AsyncMock rather than a plain MagicMock.
    """
    mock_cls = mocker.patch("src.crawler.service.AsyncWebCrawler")
    mock_instance = MagicMock(spec=AsyncWebCrawler)
    mock_instance.__aenter__.return_value = mock_instance
    mock_instance.__aexit__.return_value = False
    mock_cls.return_value = mock_instance
    return mock_instance


def test_run_returns_cleaned_html_on_success(mocker: MockerFixture) -> None:
    """A successful crawl returns its cleaned HTML."""
    mock_instance = _mock_crawler(mocker)
    mock_instance.arun.return_value = MagicMock(
        success=True, cleaned_html="<html>content</html>", error_message=None
    )

    result = Crawler().run("https://example.com")

    assert result.success is True
    assert result.url == "https://example.com"
    assert result.html == "<html>content</html>"
    assert result.error_message == ""


def test_run_reports_failure_without_raising(mocker: MockerFixture) -> None:
    """A reachable-but-failed page is reported via success=False, not raised."""
    mock_instance = _mock_crawler(mocker)
    mock_instance.arun.return_value = MagicMock(
        success=False, cleaned_html=None, error_message="404 Not Found"
    )

    result = Crawler().run("https://example.com/missing")

    assert result.success is False
    assert result.html == ""
    assert result.error_message == "404 Not Found"


def test_run_truncates_oversized_html(mocker: MockerFixture) -> None:
    """Cleaned HTML past the size backstop is truncated, not sent whole."""
    mock_instance = _mock_crawler(mocker)
    oversized_html = "a" * (_MAX_HTML_CHARS * 2)
    mock_instance.arun.return_value = MagicMock(
        success=True, cleaned_html=oversized_html, error_message=None
    )

    result = Crawler().run("https://example.com")

    assert len(result.html) == _MAX_HTML_CHARS


def test_run_raises_crawler_error_when_crawl_cannot_execute(
    mocker: MockerFixture,
) -> None:
    """A failure to even run the crawl (e.g. browser launch) raises CrawlerError."""
    mocker.patch(
        "src.crawler.service.AsyncWebCrawler", side_effect=RuntimeError("boom")
    )

    with pytest.raises(CrawlerError, match="Failed to crawl"):
        Crawler().run("https://example.com")
