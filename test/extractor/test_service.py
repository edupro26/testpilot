"""Tests for src.extractor.service."""

import json
from unittest.mock import ANY, MagicMock

import pytest
from pytest_mock import MockerFixture
from src.config import LLMProviderName, Settings
from src.exceptions import CrawlerError, ExtractorError
from src.extractor.crawler import Crawler, CrawlResult
from src.extractor.service import Extractor, _keywords_for
from src.llm.provider.mock import MockProvider
from src.model.test_case import ExecutionStep, Module

_MODULE = Module(
    url="https://automationexercise.com/login",
    description="Login page",
    execution_steps=[ExecutionStep(step="Click the Login button")],
)

_TWO_STEP_MODULE = Module(
    url="https://automationexercise.com/login",
    description="Login with incorrect credentials",
    execution_steps=[
        ExecutionStep(step="Click the Login button"),
        ExecutionStep(step="Verify the error message is visible"),
    ],
)

_MOCK_SETTINGS = Settings(llm_provider=LLMProviderName.MOCK)

_AZURE_SETTINGS = Settings(
    llm_provider=LLMProviderName.AZURE_OPENAI,
    azure_deployment_name="test-deployment",
    azure_openai_api_key="test-key",
    azure_openai_endpoint="https://example.openai.azure.com",
    openai_api_version="2025-04-01-preview",
)

_VALID_RECORD = {
    "step_index": 0,
    "type": "button",
    "request_description": "The Login button",
    "identifier_type": "css",
    "identifier_tracking": "[data-qa='login-button']",
}

_ERROR_MESSAGE_RECORD = {
    "step_index": 1,
    "type": "text",
    "request_description": "The error message",
    "identifier_type": "css",
    "identifier_tracking": ".error-message",
}


def _fake_crawler(
    html: str = "<html>...</html>",
    *,
    success: bool = True,
    extracted_content: str | None = None,
    error_message: str = "",
    js_ok: bool = True,
) -> MagicMock:
    """Build a Crawler test double whose .run() returns a fixed CrawlResult."""
    crawler = MagicMock(spec=Crawler)
    crawler.run.return_value = CrawlResult(
        url=_MODULE.url,
        success=success,
        html=html,
        error_message=error_message,
        extracted_content=extracted_content,
        js_ok=js_ok,
    )
    return crawler


def _real_provider_extractor(mocker: MockerFixture, crawler: MagicMock) -> Extractor:
    """Build an Extractor wired for a real (non-mock) LLM provider."""
    mocker.patch("src.extractor.service.LLMConfig")
    mocker.patch("src.extractor.service.LLMExtractionStrategy")
    return Extractor(MockProvider(""), _AZURE_SETTINGS, crawler)


def test_run_returns_module_and_html_for_valid_mock_response() -> None:
    """A well-formed JSON response (mock provider) fills in extracted_data."""
    crawler = _fake_crawler("<html>page</html>")
    extractor = Extractor(
        MockProvider(json.dumps([_VALID_RECORD])), _MOCK_SETTINGS, crawler
    )

    result, html_by_step = extractor.run(_MODULE)

    assert result.url == _MODULE.url
    assert len(result.execution_steps[0].extracted_data) == 1
    assert (
        result.execution_steps[0].extracted_data[0].identifier_tracking
        == "[data-qa='login-button']"
    )
    assert html_by_step == ["<html>page</html>"]
    crawler.run.assert_called_once_with(_MODULE.url, js_code=None, keywords=ANY)


@pytest.mark.parametrize(
    "use_real_provider", [False, True], ids=["mock_provider", "real_provider"]
)
def test_run_raises_crawler_error_when_crawl_fails(
    mocker: MockerFixture, use_real_provider: bool
) -> None:
    """A failed crawl raises CrawlerError, for mock and real providers alike."""
    crawler = _fake_crawler(success=False, error_message="404 Not Found")
    if use_real_provider:
        extractor = _real_provider_extractor(mocker, crawler)
    else:
        extractor = Extractor(
            MockProvider("should not be called"), _MOCK_SETTINGS, crawler
        )

    with pytest.raises(CrawlerError, match="Could not crawl"):
        extractor.run(_MODULE)


def test_run_raises_extractor_error_for_malformed_json() -> None:
    """A non-JSON LLM response raises ExtractorError, not a raw JSONDecodeError.

    Both the mock and real-provider branches share the same _parse_json
    helper, so one case covers both.
    """
    crawler = _fake_crawler()
    extractor = Extractor(MockProvider("not valid json"), _MOCK_SETTINGS, crawler)

    with pytest.raises(ExtractorError, match="not valid JSON"):
        extractor.run(_MODULE)


@pytest.mark.parametrize(
    ("use_real_provider", "response_or_content", "match"),
    [
        (False, json.dumps([{"unexpected": "shape"}]), "did not match"),
        (
            True,
            json.dumps([{"error": True, "content": "LLM returned no content"}]),
            "LLM extraction failed",
        ),
    ],
    ids=["mock_schema_mismatch", "real_provider_error_item"],
)
def test_run_raises_extractor_error_for_a_bad_llm_result(
    mocker: MockerFixture, use_real_provider: bool, response_or_content: str, match: str
) -> None:
    """A shape-mismatched mock response, or a real provider's error item, both fail."""
    if use_real_provider:
        crawler = _fake_crawler(extracted_content=response_or_content)
        extractor = _real_provider_extractor(mocker, crawler)
    else:
        crawler = _fake_crawler()
        extractor = Extractor(
            MockProvider(response_or_content), _MOCK_SETTINGS, crawler
        )

    with pytest.raises(ExtractorError, match=match):
        extractor.run(_MODULE)


@pytest.mark.parametrize(
    ("feedback", "expected_in_prompt", "expected_not_in_prompt"),
    [
        ("The selector was wrong.", "The selector was wrong.", None),
        (None, None, "PREVIOUS ATTEMPT FEEDBACK"),
    ],
    ids=["feedback_included", "feedback_omitted"],
)
def test_run_feedback_section(
    feedback: str | None,
    expected_in_prompt: str | None,
    expected_not_in_prompt: str | None,
) -> None:
    """Retry feedback is included in the prompt when given, omitted otherwise."""
    captured_prompts = []

    def _capture(_system_prompt: str, user_prompt: str) -> str:
        captured_prompts.append(user_prompt)
        return json.dumps([_VALID_RECORD])

    crawler = _fake_crawler()
    extractor = Extractor(MockProvider(_capture), _MOCK_SETTINGS, crawler)

    extractor.run(_MODULE, feedback=feedback)

    if expected_in_prompt:
        assert expected_in_prompt in captured_prompts[0]
    if expected_not_in_prompt:
        assert expected_not_in_prompt not in captured_prompts[0]


def test_run_drops_records_with_out_of_range_step_index() -> None:
    """A record referencing a step that doesn't exist is dropped, not fatal."""
    records = [_VALID_RECORD, {**_VALID_RECORD, "step_index": 5}]
    crawler = _fake_crawler()
    extractor = Extractor(MockProvider(json.dumps(records)), _MOCK_SETTINGS, crawler)

    result, _html_by_step = extractor.run(_MODULE)

    assert len(result.execution_steps[0].extracted_data) == 1


def test_extractor_maps_azure_settings_to_llm_config(mocker: MockerFixture) -> None:
    """Azure settings map to the azure/<deployment> LiteLLM provider string."""
    mock_llm_config_cls = mocker.patch("src.extractor.service.LLMConfig")
    crawler = _fake_crawler()

    Extractor(MockProvider(""), _AZURE_SETTINGS, crawler)

    mock_llm_config_cls.assert_called_once_with(
        provider="azure/test-deployment",
        api_token="test-key",
        base_url="https://example.openai.azure.com",
    )


def test_run_uses_llm_extraction_strategy_for_real_providers(
    mocker: MockerFixture,
) -> None:
    """A real provider extracts as part of the crawl call via LLMExtractionStrategy.

    Chunking is disabled centrally by the Crawler now, so the strategy is no
    longer constructed with chunk_token_threshold/apply_chunking kwargs.
    """
    mocker.patch("src.extractor.service.LLMConfig")
    mock_strategy_cls = mocker.patch("src.extractor.service.LLMExtractionStrategy")
    crawler = _fake_crawler(extracted_content=json.dumps([_VALID_RECORD]))

    extractor = Extractor(MockProvider(""), _AZURE_SETTINGS, crawler)
    result, html_by_step = extractor.run(_MODULE)

    assert len(result.execution_steps[0].extracted_data) == 1
    assert html_by_step == ["<html>...</html>"]
    crawler.run.assert_called_once_with(
        _MODULE.url,
        extraction_strategy=mock_strategy_cls.return_value,
        js_code=None,
        keywords=ANY,
    )
    _args, kwargs = mock_strategy_cls.call_args
    assert "chunk_token_threshold" not in kwargs
    assert "apply_chunking" not in kwargs


def test_run_wires_up_replay_for_a_step_that_comes_up_empty() -> None:
    """A step with no extracted_data is recovered by replaying a prior click.

    Replay's own logic (JS generation, per-step recovery, edge cases) is
    tested directly in test/extractor/test_replay.py -- this only proves
    Extractor.run() actually wires up src.extractor.replay.replay.
    """
    responses = iter([json.dumps([_VALID_RECORD]), json.dumps([_ERROR_MESSAGE_RECORD])])

    def _next_response(_system_prompt: str, _user_prompt: str) -> str:
        return next(responses)

    crawler = MagicMock(spec=Crawler)
    crawler.run.side_effect = [
        CrawlResult(url=_TWO_STEP_MODULE.url, success=True, html="<html>base</html>"),
        CrawlResult(
            url=_TWO_STEP_MODULE.url, success=True, html="<html>replayed</html>"
        ),
    ]
    extractor = Extractor(MockProvider(_next_response), _MOCK_SETTINGS, crawler)

    result, html_by_step = extractor.run(_TWO_STEP_MODULE)

    assert len(result.execution_steps[0].extracted_data) == 1
    assert len(result.execution_steps[1].extracted_data) == 1
    assert (
        result.execution_steps[1].extracted_data[0].identifier_tracking
        == ".error-message"
    )
    assert html_by_step == ["<html>base</html>", "<html>replayed</html>"]
    assert crawler.run.call_count == 2
    _args, kwargs = crawler.run.call_args_list[1]
    assert "document.querySelector(" in kwargs["js_code"][0]
    assert "el.click();" in kwargs["js_code"][0]


def test_keywords_for_extracts_lowercased_tokens_from_description_and_steps() -> None:
    """Keywords are drawn from both the module description and step text."""
    keywords = _keywords_for(_MODULE)

    assert "login" in keywords
    assert "button" in keywords
    assert "click" in keywords
