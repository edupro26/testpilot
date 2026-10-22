"""Tests for src.validator.service."""

import json

import pytest
from src.exceptions import ValidatorError
from src.llm.provider.mock import MockProvider
from src.model.test_case import StepStatement
from src.validator.browser import BrowserError
from src.validator.service import Validator

_STEP = "Verify the error message is visible"
_STATEMENT = StepStatement(
    code='expect(page.get_by_text("incorrect!")).to_be_visible()'
)


class FakeBrowser:
    """Stands in for the validation browser."""

    def __init__(self, failure: BrowserError | None = None) -> None:
        """Initialize, optionally failing every run with `failure`."""
        self._failure = failure
        self.replayed: list[list[StepStatement]] = []
        self.url = "https://example.com/login"

    @property
    def page(self) -> "FakeBrowser":
        """Stand in for the live page, which only needs url and title."""
        return self

    def title(self) -> str:
        """The page title the semantic prompt reports."""
        return "Login"

    def run(self, statements: list[StepStatement]) -> None:
        """Record the run, raising the configured failure if there is one."""
        self.replayed.append(statements)
        if self._failure is not None:
            raise self._failure


def _verdict(is_valid: bool, reason: str = "", reasons: list[str] | None = None) -> str:
    return json.dumps(
        {"is_valid": is_valid, "reason": reason, "statement_reasons": reasons or []}
    )


def test_passes_when_replay_and_the_semantic_check_agree() -> None:
    """The happy path: proven code that tests the right thing."""
    browser = FakeBrowser()

    verdict = Validator(MockProvider(_verdict(True, "ok")), browser).run(
        _STEP, [_STATEMENT]
    )

    assert verdict.is_valid
    assert browser.replayed == [[_STATEMENT]]


def test_a_replay_failure_short_circuits_the_llm_call() -> None:
    """Code that cannot run needs no semantic opinion -- and no tokens."""
    failure = BrowserError(_STATEMENT.code, "Timeout 5000ms exceeded")
    llm = MockProvider(_verdict(True, "should never be consulted"))

    verdict = Validator(llm, FakeBrowser(failure)).run(_STEP, [_STATEMENT])

    assert not verdict.is_valid
    assert "Timeout 5000ms exceeded" in verdict.feedback
    assert _STATEMENT.code in verdict.feedback


def test_rejects_code_that_runs_but_tests_the_wrong_thing() -> None:
    """The one question replay cannot answer."""
    llm = MockProvider(_verdict(False, "asserts a heading, not the error message"))

    verdict = Validator(llm, FakeBrowser()).run(_STEP, [_STATEMENT])

    assert not verdict.is_valid
    assert "heading" in verdict.feedback
    assert verdict.statements == []


def test_each_accepted_statement_gets_its_own_reason() -> None:
    """Reasons are matched to statements by position."""
    click = StepStatement(code='page.get_by_role("button", name="Login").click()')
    llm = MockProvider(_verdict(True, "ok", ["clicks Login", "asserts the error"]))

    verdict = Validator(llm, FakeBrowser()).run(_STEP, [click, _STATEMENT])

    assert [s.code for s in verdict.statements] == [click.code, _STATEMENT.code]
    assert [s.reason for s in verdict.statements] == [
        "clicks Login",
        "asserts the error",
    ]


def test_a_reason_count_mismatch_falls_back_to_the_step_reason() -> None:
    """The reasons are informational, so a miscount must not fail the step."""
    llm = MockProvider(_verdict(True, "does what the step asks", ["a", "b"]))

    verdict = Validator(llm, FakeBrowser()).run(_STEP, [_STATEMENT])

    assert verdict.is_valid
    assert [s.reason for s in verdict.statements] == ["does what the step asks"]


def test_a_step_with_no_statements_is_trivially_valid() -> None:
    """Some steps genuinely need no browser interaction."""
    browser = FakeBrowser()

    verdict = Validator(MockProvider("never called"), browser).run(_STEP, [])

    assert verdict.is_valid
    assert browser.replayed == []


def test_the_step_and_code_reach_the_prompt() -> None:
    """The semantic judge needs both, or it cannot judge."""
    seen: dict[str, str] = {}

    def capture(_system: str, user: str) -> str:
        seen["prompt"] = user
        return _verdict(True)

    Validator(MockProvider(capture), FakeBrowser()).run(_STEP, [_STATEMENT])

    assert _STEP in seen["prompt"]
    assert f"1. {_STATEMENT.code}" in seen["prompt"]


def test_errors_on_a_non_json_response() -> None:
    """A malformed verdict must fail loudly, not pass silently."""
    with pytest.raises(ValidatorError, match="not valid JSON"):
        Validator(MockProvider("certainly!"), FakeBrowser()).run(_STEP, [_STATEMENT])


def test_errors_on_a_wrongly_shaped_response() -> None:
    """A verdict missing is_valid cannot be acted on."""
    with pytest.raises(ValidatorError, match="did not match"):
        Validator(MockProvider(json.dumps({"ok": True})), FakeBrowser()).run(
            _STEP, [_STATEMENT]
        )
