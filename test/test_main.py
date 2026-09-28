"""Tests for src.main: the pipeline's actual wiring and retry-on-failure loop."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import typer
from pytest_mock import MockerFixture
from src.exceptions import CrawlerError, ExtractorError, ValidatorError
from src.extractor.crawler import CrawlResult
from src.extractor.service import Extractor
from src.llm.provider.mock import MockProvider
from src.main import _extract_module, _load_settings_or_fail, app
from src.model.test_case import ExecutionStep, Module
from src.validator.service import IdentifierVerdict, ValidationResult, Validator
from typer.testing import CliRunner

_MODULE = Module(
    url="https://example.com/login",
    description="Login page",
    execution_steps=[ExecutionStep(step="Click the login button")],
)


def _passing_result() -> ValidationResult:
    return ValidationResult(
        verdicts=[
            IdentifierVerdict(identifier_tracking="#login", is_valid=True, reason="ok")
        ]
    )


def _failing_result() -> ValidationResult:
    return ValidationResult(
        verdicts=[
            IdentifierVerdict(
                identifier_tracking="#login", is_valid=False, reason="not found"
            )
        ]
    )


def test_extract_module_succeeds_without_retry_when_validation_passes() -> None:
    """A module that validates on the first attempt returns immediately, no retry."""
    extractor = MagicMock(spec=Extractor)
    extractor.run.return_value = (_MODULE, ["<html></html>"])
    validator = MagicMock(spec=Validator)
    validator.run.return_value = _passing_result()

    result = _extract_module(_MODULE, extractor, validator)

    assert result is _MODULE
    assert extractor.run.call_count == 1
    assert validator.run.call_count == 1


def test_extract_module_retries_once_with_feedback_and_succeeds() -> None:
    """A failed first validation retries exactly once, with feedback threaded in."""
    first_attempt = _MODULE.model_copy(update={"description": "first attempt"})
    second_attempt = _MODULE.model_copy(update={"description": "second attempt"})
    extractor = MagicMock(spec=Extractor)
    extractor.run.side_effect = [
        (first_attempt, ["<html>first</html>"]),
        (second_attempt, ["<html>second</html>"]),
    ]
    failing_result = _failing_result()
    validator = MagicMock(spec=Validator)
    validator.run.side_effect = [failing_result, _passing_result()]

    result = _extract_module(_MODULE, extractor, validator)

    assert result is second_attempt
    assert extractor.run.call_count == 2
    _args, kwargs = extractor.run.call_args_list[1]
    assert kwargs["feedback"] == failing_result.feedback


def test_extract_module_raises_after_second_validation_also_fails() -> None:
    """Both attempts failing raises ValidatorError with the URL, no 3rd attempt."""
    extractor = MagicMock(spec=Extractor)
    extractor.run.return_value = (_MODULE, ["<html></html>"])
    failing_result = _failing_result()
    validator = MagicMock(spec=Validator)
    validator.run.return_value = failing_result

    with pytest.raises(ValidatorError, match=_MODULE.url) as exc_info:
        _extract_module(_MODULE, extractor, validator)

    assert failing_result.feedback in str(exc_info.value)
    assert extractor.run.call_count == 2
    assert validator.run.call_count == 2


@pytest.mark.parametrize(
    "error_cls",
    [CrawlerError, ExtractorError],
    ids=["crawler_error", "extractor_error"],
)
def test_extract_module_lets_extractor_failures_propagate_uncaught(
    error_cls: type,
) -> None:
    """A CrawlerError/ExtractorError from Extractor.run propagates, not swallowed."""
    extractor = MagicMock(spec=Extractor)
    extractor.run.side_effect = error_cls("boom")
    validator = MagicMock(spec=Validator)

    with pytest.raises(error_cls, match="boom"):
        _extract_module(_MODULE, extractor, validator)

    validator.run.assert_not_called()


@pytest.mark.usefixtures("isolated_settings_env")
def test_load_settings_or_fail_exits_on_invalid_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bad Settings() (invalid LLM_PROVIDER) fails before any LLM call is made."""
    monkeypatch.setenv("LLM_PROVIDER", "not-a-real-provider")

    with pytest.raises(typer.Exit):
        _load_settings_or_fail()


@pytest.mark.usefixtures("isolated_settings_env")
def test_cli_runs_the_full_pipeline_against_a_mock_provider(
    mocker: MockerFixture, tmp_path: Path
) -> None:
    """The CLI runs the full pipeline end to end and writes the generated script.

    Entirely offline: both the Crawler and the LLM provider are mocked.
    """
    markdown_path = tmp_path / "case.md"
    markdown_path.write_text("# Smoke test\n\nClick the login button.")

    structurer_json = json.dumps(
        {
            "name": "Smoke Test",
            "modules": [
                {
                    "url": "https://example.com",
                    "description": "Home page",
                    "execution_steps": [{"step": "Click the login button"}],
                }
            ],
        }
    )
    extractor_json = json.dumps(
        [
            {
                "step_index": 0,
                "type": "button",
                "request_description": "The login button",
                "identifier_type": "css",
                "identifier_tracking": "#login",
            }
        ]
    )
    validator_json = json.dumps(
        {
            "verdicts": [
                {"identifier_tracking": "#login", "is_valid": True, "reason": "ok"}
            ]
        }
    )
    generator_script = (
        "from playwright.sync_api import Page, expect\n\n\n"
        "def test_smoke_test(page: Page) -> None:\n"
        "    # MODULE 0\n"
        '    page.locator("css=#login").click()\n'
    )
    responses = iter(
        [structurer_json, extractor_json, validator_json, generator_script]
    )

    def _next_response(_system_prompt: str, _user_prompt: str) -> str:
        return next(responses)

    mocker.patch("src.main.get_llm_provider", return_value=MockProvider(_next_response))
    mock_crawler_cls = mocker.patch("src.main.Crawler")
    mock_crawler_cls.return_value.run.return_value = CrawlResult(
        url="https://example.com",
        success=True,
        html="<html><body><button id='login'>Login</button></body></html>",
    )

    result = CliRunner().invoke(app, [str(markdown_path)])

    assert result.exit_code == 0, result.output

    script_path = tmp_path / "output" / "case.py"
    assert script_path.exists()
    script = script_path.read_text(encoding="utf-8")
    assert 'page.locator("css=#login")' in script
    assert "_dismiss_overlays(page)" in script
