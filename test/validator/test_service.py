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


def test_accepts_proven_code_that_tests_the_right_thing() -> None:
    """The happy path: the code replays, and the judge sees step and code.

    Reasons are matched to statements by position; being informational, a
    miscount falls back to the step's reason rather than failing it.
    """
    click = StepStatement(code='page.get_by_role("button", name="Login").click()')
    browser = FakeBrowser()
    seen: dict[str, str] = {}

    def capture(_system: str, user: str) -> str:
        seen["prompt"] = user
        return _verdict(True, "ok", ["clicks Login", "asserts the error"])

    verdict = Validator(MockProvider(capture), browser).run(_STEP, [click, _STATEMENT])

    assert verdict.is_valid
    assert browser.replayed == [[click, _STATEMENT]]
    assert [s.code for s in verdict.statements] == [click.code, _STATEMENT.code]
    assert [s.reason for s in verdict.statements] == [
        "clicks Login",
        "asserts the error",
    ]
    assert _STEP in seen["prompt"]
    assert f"1. {click.code}" in seen["prompt"]
    assert f"2. {_STATEMENT.code}" in seen["prompt"]

    miscounted = MockProvider(_verdict(True, "does what the step asks", ["a", "b"]))
    verdict = Validator(miscounted, FakeBrowser()).run(_STEP, [_STATEMENT])

    assert verdict.is_valid
    assert [s.reason for s in verdict.statements] == ["does what the step asks"]


def test_rejects_code_that_fails_replay_or_tests_the_wrong_thing() -> None:
    """Replay proves the code runs; only the judge can say it is the right code.

    A replay failure short-circuits the judge: no semantic opinion, no tokens.
    """
    failure = BrowserError(_STATEMENT.code, "Timeout 5000ms exceeded")
    never_asked = MockProvider(_verdict(True, "should never be consulted"))

    verdict = Validator(never_asked, FakeBrowser(failure)).run(_STEP, [_STATEMENT])

    assert not verdict.is_valid
    assert "Timeout 5000ms exceeded" in verdict.feedback
    assert _STATEMENT.code in verdict.feedback

    judge = MockProvider(_verdict(False, "asserts a heading, not the error message"))
    verdict = Validator(judge, FakeBrowser()).run(_STEP, [_STATEMENT])

    assert not verdict.is_valid
    assert "heading" in verdict.feedback
    assert verdict.statements == []


def test_a_step_with_no_statements_is_trivially_valid() -> None:
    """Some steps genuinely need no browser interaction."""
    browser = FakeBrowser()

    verdict = Validator(MockProvider("never called"), browser).run(_STEP, [])

    assert verdict.is_valid
    assert browser.replayed == []


def test_errors_on_an_unusable_verdict() -> None:
    """A malformed or wrongly shaped verdict must fail loudly, not pass silently."""
    with pytest.raises(ValidatorError, match="not valid JSON"):
        Validator(MockProvider("certainly!"), FakeBrowser()).run(_STEP, [_STATEMENT])

    with pytest.raises(ValidatorError, match="did not match"):
        Validator(MockProvider(json.dumps({"ok": True})), FakeBrowser()).run(
            _STEP, [_STATEMENT]
        )
