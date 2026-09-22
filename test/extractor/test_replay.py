"""Tests for src.extractor.replay."""

import pytest
from src.exceptions import CrawlerError
from src.extractor.records import CrawlExtraction
from src.extractor.replay import _action_js, _is_actionable, _selector_js, replay
from src.model.enums import ElementType, IdentifierType
from src.model.test_case import ExecutionStep, ExtractedData, Module

_BUTTON = ExtractedData(
    type=ElementType.BUTTON,
    request_description="The Login button",
    identifier_type=IdentifierType.CSS,
    identifier_tracking="[data-qa='login-button']",
)

_TEXT_ONLY = ExtractedData(
    type=ElementType.TEXT,
    request_description="Welcome message",
    identifier_type=IdentifierType.TEXT,
    identifier_tracking="Welcome",
)

_ERROR_MESSAGE_RECORD = {
    "step_index": 1,
    "type": "text",
    "request_description": "The error message",
    "identifier_type": "css",
    "identifier_tracking": ".error-message",
}


def _two_step_module(first_step_data: list[ExtractedData]) -> Module:
    """Build a 2-step module: step 0 has `first_step_data`, step 1 is empty."""
    first_step = ExecutionStep(
        step="Click the Login button", extracted_data=first_step_data
    )
    return Module(
        url="https://automationexercise.com/login",
        description="Login with incorrect credentials",
        execution_steps=[
            first_step,
            ExecutionStep(step="Verify the error message is visible"),
        ],
    )


def test_replay_recovers_a_step_that_comes_up_empty() -> None:
    """A step with no extracted_data is recovered by replaying a prior click."""
    module = _two_step_module([_BUTTON])
    html_by_step = ["<html>base</html>", "<html>base</html>"]
    calls = []

    def run_crawl(
        _url: str, _instruction: str, _keywords: frozenset[str], js_code: list[str]
    ) -> CrawlExtraction:
        calls.append(js_code)
        return CrawlExtraction(
            records=[_ERROR_MESSAGE_RECORD], html="<html>replayed</html>", js_ok=True
        )

    result_module, result_html = replay(
        module, html_by_step, frozenset(), "", run_crawl
    )

    assert len(result_module.execution_steps[1].extracted_data) == 1
    assert (
        result_module.execution_steps[1].extracted_data[0].identifier_tracking
        == ".error-message"
    )
    assert result_html == ["<html>base</html>", "<html>replayed</html>"]
    assert len(calls) == 1
    assert "document.querySelector(" in calls[0][0]
    assert "el.click();" in calls[0][0]


def test_replay_skips_when_no_actionable_predecessor_exists() -> None:
    """A step with only a text= predecessor (not actionable) is left empty."""
    module = _two_step_module([_TEXT_ONLY])
    html_by_step = ["<html>base</html>", "<html>base</html>"]
    calls = []

    def run_crawl(
        _url: str, _instruction: str, _keywords: frozenset[str], js_code: list[str]
    ) -> CrawlExtraction:
        calls.append(js_code)
        raise AssertionError("should not be called")

    result_module, result_html = replay(
        module, html_by_step, frozenset(), "", run_crawl
    )

    assert calls == []
    assert result_module.execution_steps[1].extracted_data == []
    assert result_html == ["<html>base</html>", "<html>base</html>"]


def test_replay_continues_when_crawl_fails() -> None:
    """A failed replay crawl leaves the step empty, without raising."""
    module = _two_step_module([_BUTTON])
    html_by_step = ["<html>base</html>", "<html>base</html>"]

    def run_crawl(
        _url: str, _instruction: str, _keywords: frozenset[str], _js_code: list[str]
    ) -> CrawlExtraction:
        raise CrawlerError("timeout")

    result_module, result_html = replay(
        module, html_by_step, frozenset(), "", run_crawl
    )

    assert result_module.execution_steps[1].extracted_data == []
    assert result_html[1] == "<html>base</html>"


def test_replay_continues_when_replayed_action_fails() -> None:
    """A failed replay action (js_ok=False) leaves the step empty."""
    module = _two_step_module([_BUTTON])
    html_by_step = ["<html>base</html>", "<html>base</html>"]

    def run_crawl(
        _url: str, _instruction: str, _keywords: frozenset[str], _js_code: list[str]
    ) -> CrawlExtraction:
        return CrawlExtraction(
            records=[_ERROR_MESSAGE_RECORD], html="<html>replayed</html>", js_ok=False
        )

    result_module, result_html = replay(
        module, html_by_step, frozenset(), "", run_crawl
    )

    assert result_module.execution_steps[1].extracted_data == []
    assert result_html[1] == "<html>base</html>"


# --- Pure helper functions -----------------------------------------------


@pytest.mark.parametrize(
    ("identifier_type", "tracking", "expected_substrings"),
    [
        (
            IdentifierType.ID,
            "login-button",
            ['document.getElementById("login-button")'],
        ),
        (IdentifierType.CSS, "[data-qa='login-button']", ["document.querySelector("]),
        (
            IdentifierType.XPATH,
            "//button",
            ["document.evaluate(", "FIRST_ORDERED_NODE_TYPE"],
        ),
    ],
    ids=["id", "css", "xpath"],
)
def test_selector_js_resolves_via_the_matching_dom_api(
    identifier_type: IdentifierType, tracking: str, expected_substrings: list[str]
) -> None:
    """Each identifier_type resolves via its matching DOM lookup API."""
    js = _selector_js(identifier_type, tracking)

    for substring in expected_substrings:
        assert substring in js


@pytest.mark.parametrize(
    ("item", "expected_substrings"),
    [
        (
            ExtractedData(
                type=ElementType.BUTTON,
                request_description="Login",
                identifier_type=IdentifierType.ID,
                identifier_tracking="login",
            ),
            ["el.click();"],
        ),
        (
            ExtractedData(
                type=ElementType.INPUT,
                request_description="Email",
                identifier_type=IdentifierType.ID,
                identifier_tracking="email",
                input_value="notarealuser@example.com",
            ),
            [
                "notarealuser@example.com",
                "dispatchEvent(new Event('input'",
                "dispatchEvent(new Event('change'",
                "el.blur();",
            ],
        ),
        (
            ExtractedData(
                type=ElementType.DROPDOWN,
                request_description="Country",
                identifier_type=IdentifierType.ID,
                identifier_tracking="country",
                input_value="Portugal",
            ),
            ["Portugal", "dispatchEvent(new Event('change'"],
        ),
        (
            ExtractedData(
                type=ElementType.DROPDOWN,
                request_description="Menu",
                identifier_type=IdentifierType.ID,
                identifier_tracking="menu",
            ),
            ["el.click();"],
        ),
    ],
    ids=[
        "button_clicks",
        "input_fills_and_dispatches_events",
        "dropdown_with_value_selects_it",
        "dropdown_without_value_clicks_it",
    ],
)
def test_action_js_produces_the_right_script_shape(
    item: ExtractedData, expected_substrings: list[str]
) -> None:
    """Each element/value combination produces the right JS, guarded against a miss."""
    js = _action_js(item)

    assert "throw new Error" in js  # every action guards against a missing target
    for substring in expected_substrings:
        assert substring in js


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        (
            ExtractedData(
                type=ElementType.BUTTON,
                request_description="Login",
                identifier_type=IdentifierType.TEXT,
                identifier_tracking="Login",
            ),
            False,
        ),
        (
            ExtractedData(
                type=ElementType.INPUT,
                request_description="Email",
                identifier_type=IdentifierType.ID,
                identifier_tracking="email",
            ),
            False,
        ),
        (
            ExtractedData(
                type=ElementType.BUTTON,
                request_description="Login",
                identifier_type=IdentifierType.ID,
                identifier_tracking="login",
            ),
            True,
        ),
    ],
    ids=["text_identifier_excluded", "input_without_value_excluded", "button_included"],
)
def test_is_actionable(item: ExtractedData, expected: bool) -> None:
    """A button is actionable; a text= identifier or a valueless input isn't."""
    assert _is_actionable(item) is expected
