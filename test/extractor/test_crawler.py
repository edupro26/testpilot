"""Tests for src.extractor.crawler."""

from unittest.mock import MagicMock

import pytest
from crawl4ai import AsyncWebCrawler
from crawl4ai.extraction_strategy import LLMExtractionStrategy
from pytest_mock import MockerFixture
from src.exceptions import CrawlerError
from src.extractor.crawler import Crawler, _get_crawler_config


def _mock_crawler(mocker: MockerFixture) -> MagicMock:
    """Patch AsyncWebCrawler with a mock usable as `async with ... as x`."""
    mock_cls = mocker.patch("src.extractor.crawler.AsyncWebCrawler")
    mock_instance = MagicMock(spec=AsyncWebCrawler)
    mock_instance.__aenter__.return_value = mock_instance
    mock_instance.__aexit__.return_value = False
    mock_cls.return_value = mock_instance
    return mock_instance


def _page_result(**overrides: object) -> MagicMock:
    """Build a mocked Crawl4AI page result, with sane defaults."""
    defaults: dict[str, object] = {
        "success": True,
        "cleaned_html": "<html><body>content</body></html>",
        "error_message": None,
        "extracted_content": None,
        "js_execution_result": None,
    }
    return MagicMock(**{**defaults, **overrides})


def test_run_returns_cleaned_html_and_extracted_content_on_success(
    mocker: MockerFixture,
) -> None:
    """A successful crawl returns cleaned HTML and any extracted content."""
    mock_instance = _mock_crawler(mocker)
    mock_instance.arun.return_value = _page_result(extracted_content='[{"foo": "bar"}]')

    result = Crawler().run("https://example.com")

    assert result.success is True
    assert result.url == "https://example.com"
    assert "content" in result.html
    assert result.error_message == ""
    assert result.extracted_content == '[{"foo": "bar"}]'
    assert result.js_ok is True


def test_run_reports_failure_without_raising(mocker: MockerFixture) -> None:
    """A reachable-but-failed page is reported via success=False, not raised.

    A stale extracted_content from before the failure never surfaces.
    """
    mock_instance = _mock_crawler(mocker)
    mock_instance.arun.return_value = _page_result(
        success=False,
        cleaned_html=None,
        error_message="404 Not Found",
        extracted_content='[{"should": "not appear"}]',
    )

    result = Crawler().run("https://example.com/missing")

    assert result.success is False
    assert result.html == ""
    assert result.error_message == "404 Not Found"
    assert result.extracted_content is None


def test_run_raises_crawler_error_when_crawl_cannot_execute(
    mocker: MockerFixture,
) -> None:
    """A failure to even run the crawl (e.g. browser launch) raises CrawlerError."""
    mocker.patch(
        "src.extractor.crawler.AsyncWebCrawler", side_effect=RuntimeError("boom")
    )

    with pytest.raises(CrawlerError, match="Failed to crawl"):
        Crawler().run("https://example.com")


@pytest.mark.parametrize(
    "js_execution_result",
    [None, {"success": True, "results": [{"success": True}, {"success": True}]}],
    ids=["no_js_code_run", "every_script_succeeded"],
)
def test_run_reports_js_ok_true(
    mocker: MockerFixture, js_execution_result: dict | None
) -> None:
    """js_ok is True with no js_code run, or when every script succeeded."""
    mock_instance = _mock_crawler(mocker)
    mock_instance.arun.return_value = _page_result(
        js_execution_result=js_execution_result
    )

    result = Crawler().run("https://example.com", js_code=["a();"])

    assert result.js_ok is True


@pytest.mark.parametrize(
    "js_execution_result",
    [
        {
            "success": True,
            "results": [{"success": True}, {"success": False, "error": "not found"}],
        },
        {"success": False, "error": "boom"},
    ],
    ids=["one_script_failed", "catastrophic_execution_failure"],
)
def test_run_reports_js_ok_false(
    mocker: MockerFixture, js_execution_result: dict
) -> None:
    """js_ok is False if any script fails, even under an outer success=True.

    Crawl4AI's outer js_execution_result["success"] stays True even when an
    individual script throws (its failure is only recorded per-script in
    "results"), so js_ok must inspect each script's own outcome.
    """
    mock_instance = _mock_crawler(mocker)
    mock_instance.arun.return_value = _page_result(
        js_execution_result=js_execution_result
    )

    result = Crawler().run("https://example.com", js_code=["a();", "b();"])

    assert result.js_ok is False


def test_run_config_wires_extraction_settings_into_crawler_run_config() -> None:
    """Every run() knob reaches the built CrawlerRunConfig as expected.

    apply_chunking is always forced off regardless of the caller's strategy
    settings -- Crawl4AI's own chunking splits raw HTML on whitespace with no
    regard for HTML tags, and fires every chunk as a fully concurrent,
    unthrottled LLM call.
    """
    strategy = LLMExtractionStrategy()
    strategy.apply_chunking = True
    strategy.chunk_token_threshold = 2048
    js_code = ["document.querySelector('#login').click();"]
    keywords = frozenset({"login", "email"})

    config = _get_crawler_config(strategy, js_code, keywords)

    assert strategy.apply_chunking is False
    assert strategy.chunk_token_threshold == 1e9
    assert config.js_code == js_code
    assert config.extraction_strategy is strategy
    assert config.scraping_strategy._keywords == keywords  # noqa: SLF001
