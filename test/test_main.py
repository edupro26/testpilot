"""Tests for src.main: the pipeline's wiring and its retry-on-failure loop."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import typer
from pytest_mock import MockerFixture
from src.exceptions import ExtractorError, McpError, ValidatorError
from src.extractor.mcp.server import PlaywrightMCP
from src.extractor.service import Extractor
from src.llm.provider.mock import MockProvider
from src.main import _extract_step, _load_settings_or_fail, app
from src.model.test_case import ExecutionStep, Module, StepStatement
from src.validator.browser import ValidationBrowser
from src.validator.service import StepVerdict, Validator
from typer.testing import CliRunner, Result

_CLICK = 'page.get_by_role("button", name="Login").click()'
_ASSERT = 'expect(page.get_by_text("Welcome")).to_be_visible()'

_MODULE = Module(
    url="https://example.com/login",
    description="Login page",
    execution_steps=[ExecutionStep(step="Click the login button")],
)


def _statements(code: str = _CLICK) -> list[StepStatement]:
    return [StepStatement(code=code)]


def _browsers() -> tuple[MagicMock, MagicMock]:
    """A fake MCP connection and validation browser, for the retry wiring."""
    mcp = MagicMock(spec=PlaywrightMCP)
    browser = MagicMock(spec=ValidationBrowser)
    browser.page.url = "https://example.com/login"
    return mcp, browser


def test_a_step_that_validates_first_time_costs_one_loop_and_no_reset() -> None:
    """The happy path: one agent loop, and no reconnect or page reload."""
    extractor = MagicMock(spec=Extractor)
    extractor.run_step.return_value = _statements()
    accepted = [StepStatement(code=_CLICK, reason="clicks the login button")]
    validator = MagicMock(spec=Validator)
    validator.run.return_value = StepVerdict(is_valid=True, statements=accepted)
    mcp, browser = _browsers()

    result = _extract_step(_MODULE, 0, extractor, validator, mcp, browser, [])

    assert result == accepted
    assert extractor.run_step.call_count == 1
    mcp.reset.assert_not_called()
    browser.reset.assert_not_called()


def test_a_rejected_step_resets_both_browsers_and_retries_with_feedback() -> None:
    """A blind retry, or one against the failed attempt's state, is worthless.

    Both browsers are reset (the MCP one would otherwise still carry, say, an
    accepted cookie banner), the validated prefix is replayed, and the
    rejection reaches the agent.
    """
    extractor = MagicMock(spec=Extractor)
    second = _statements('page.get_by_role("button", name="Sign in").click()')
    extractor.run_step.side_effect = [_statements(), second]
    rejection = StepVerdict(is_valid=False, reason="cookie banner blocked the click")
    validator = MagicMock(spec=Validator)
    validator.run.side_effect = [
        rejection,
        StepVerdict(is_valid=True, statements=second),
    ]
    mcp, browser = _browsers()
    history = ['page.goto("https://example.com")']

    result = _extract_step(_MODULE, 0, extractor, validator, mcp, browser, history)

    assert result == second
    assert extractor.run_step.call_count == 2
    retry = extractor.run_step.call_args_list[1].kwargs
    assert retry["feedback"] == rejection.feedback
    assert retry["reset_to"] == "https://example.com/login"

    mcp.reset.assert_called_once()
    browser.reset.assert_called_once()
    mcp.call_tool.assert_called_once_with(
        "browser_navigate", {"url": "https://example.com/login"}
    )
    replayed = browser.run.call_args[0][0]
    assert [s.code for s in replayed] == history


def test_a_step_failing_twice_aborts_the_run() -> None:
    """Functional req 10: retry once, then stop with a clear error."""
    extractor = MagicMock(spec=Extractor)
    extractor.run_step.return_value = _statements()
    validator = MagicMock(spec=Validator)
    validator.run.return_value = StepVerdict(is_valid=False, reason="still wrong")

    with pytest.raises(ValidatorError, match="after retry") as excinfo:
        _extract_step(_MODULE, 0, extractor, validator, *_browsers(), [])

    assert "still wrong" in str(excinfo.value)
    assert extractor.run_step.call_count == 2


@pytest.mark.parametrize("error_cls", [ExtractorError, McpError])
def test_extraction_failures_propagate_rather_than_being_retried(
    error_cls: type,
) -> None:
    """A rejected statement or a dead MCP server is not a validation failure."""
    extractor = MagicMock(spec=Extractor)
    extractor.run_step.side_effect = error_cls("boom")
    validator = MagicMock(spec=Validator)

    with pytest.raises(error_cls, match="boom"):
        _extract_step(_MODULE, 0, extractor, validator, *_browsers(), [])

    validator.run.assert_not_called()


@pytest.mark.usefixtures("isolated_settings_env")
def test_invalid_configuration_fails_before_any_llm_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bad LLM_PROVIDER must not get as far as opening a browser."""
    monkeypatch.setenv("LLM_PROVIDER", "not-a-real-provider")

    with pytest.raises(typer.Exit):
        _load_settings_or_fail()


_SMOKE_SCRIPT = f"""\"\"\"Smoke test.\"\"\"

import pytest
from playwright.sync_api import Page, expect


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args: dict) -> dict:
    \"\"\"Pin the locale these locators were validated under.\"\"\"
    return {{**browser_context_args, "locale": "en-US"}}


def test_smoke_test(page: Page) -> None:
    \"\"\"Log in and see the welcome message.\"\"\"
    # Click the login button
    {_CLICK}

    # Verify the welcome message
    {_ASSERT}
"""


def _run_cli(
    mocker: MockerFixture, tmp_path: Path, generator_reply: str
) -> tuple[Result, Path]:
    """Run the CLI offline: MCP, the browser and the extractor are faked."""
    markdown_path = tmp_path / "automation" / "case.md"
    markdown_path.parent.mkdir()
    markdown_path.write_text("# Smoke test\n\nClick login, see the welcome.")

    structurer_json = json.dumps(
        {
            "name": "Smoke Test",
            "modules": [
                {
                    "url": "https://example.com",
                    "description": "Home page",
                    "execution_steps": [
                        {"step": "Click the login button"},
                        {"step": "Verify the welcome message"},
                    ],
                }
            ],
        }
    )
    verdict = json.dumps({"is_valid": True, "reason": "ok"})
    responses = iter([structurer_json, verdict, verdict, generator_reply])

    mocker.patch(
        "src.main.get_llm_provider",
        return_value=MockProvider(lambda _s, _u: next(responses)),
    )
    mocker.patch("src.main.PlaywrightMCP")
    mocker.patch("src.main.ValidationBrowser")
    extractor = mocker.patch("src.main.Extractor")
    extractor.return_value.run_step.side_effect = [
        _statements(_CLICK),
        _statements(_ASSERT),
    ]

    result = CliRunner().invoke(app, [str(markdown_path)])
    return result, tmp_path / "output" / "automation"


@pytest.mark.usefixtures("isolated_settings_env")
def test_cli_runs_the_full_pipeline_offline(
    mocker: MockerFixture, tmp_path: Path
) -> None:
    """The CLI runs end to end and writes both artifacts, with no network.

    MCP and the validation browser are both faked, so this exercises the real
    wiring without a server (non-functional req 7). Each step's statements
    must land on that step in the persisted JSON.
    """
    result, output_dir = _run_cli(mocker, tmp_path, _SMOKE_SCRIPT)

    assert result.exit_code == 0, result.output

    script = (output_dir / "case.py").read_text(encoding="utf-8")
    assert _CLICK in script
    assert _ASSERT in script

    persisted = json.loads((output_dir / "case.json").read_text(encoding="utf-8"))
    steps = persisted["modules"][0]["execution_steps"]
    assert [[s["code"] for s in step["statements"]] for step in steps] == [
        [_CLICK],
        [_ASSERT],
    ]


@pytest.mark.usefixtures("isolated_settings_env")
def test_a_generation_failure_keeps_the_validated_json(
    mocker: MockerFixture, tmp_path: Path
) -> None:
    """Validation is the expensive part, so its JSON is on disk before generation."""
    result, output_dir = _run_cli(mocker, tmp_path, "not a script at all")

    assert result.exit_code == 1
    assert (output_dir / "case.json").exists()
    assert not (output_dir / "case.py").exists()
