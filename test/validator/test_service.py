"""Tests for src.validator.service."""

import json
from collections.abc import Callable

import pytest
from src.exceptions import ValidatorError
from src.llm.provider.mock import MockProvider
from src.model.test_case import ExecutionStep, ExtractedData, Module
from src.validator.service import IdentifierVerdict, ValidationResult, Validator

_EXTRACTED = ExtractedData(
    type="button",
    request_description="The Login button",
    identifier_type="css",
    identifier_tracking="[data-qa='login-button']",
)

_MODULE = Module(
    url="https://automationexercise.com/login",
    description="Login page",
    execution_steps=[
        ExecutionStep(step="Click the Login button", extracted_data=[_EXTRACTED])
    ],
)

_EMPTY_MODULE = Module(
    url="https://automationexercise.com",
    description="Home page",
    execution_steps=[ExecutionStep(step="Navigate to the login page")],
)

_VALID_RESPONSE = json.dumps(
    {
        "verdicts": [
            {
                "identifier_tracking": "[data-qa='login-button']",
                "is_valid": True,
                "reason": "Matches the Login <button> in the HTML",
            }
        ]
    }
)

_UNIQUE_HTML = "<button data-qa='login-button'>Login</button>"

_DUPLICATE_HTML = (
    "<button data-qa='login-button'>Login</button>"
    "<button data-qa='login-button'>Login</button>"
)


def test_run_returns_validation_result_for_valid_llm_response() -> None:
    """A well-formed JSON response is parsed into a ValidationResult."""
    validator = Validator(MockProvider(_VALID_RESPONSE))

    result = validator.run(_MODULE, [_UNIQUE_HTML])

    assert result.is_valid is True
    assert result.verdicts[0].identifier_tracking == "[data-qa='login-button']"


def test_run_raises_validator_error_for_malformed_json() -> None:
    """A non-JSON response raises ValidatorError, not a raw JSONDecodeError."""
    validator = Validator(MockProvider("not valid json"))

    with pytest.raises(ValidatorError, match="not valid JSON"):
        validator.run(_MODULE, ["<html></html>"])


def test_run_raises_validator_error_for_schema_mismatch() -> None:
    """Valid JSON not matching the ValidationResult shape raises ValidatorError."""
    malformed = json.dumps({"verdicts": [{"identifier_tracking": "x"}]})
    validator = Validator(MockProvider(malformed))

    with pytest.raises(ValidatorError, match="did not match"):
        validator.run(_MODULE, ["<html></html>"])


def test_run_raises_validator_error_on_verdict_count_mismatch() -> None:
    """Returning the wrong number of verdicts is a hard validator error."""
    response = json.dumps({"verdicts": []})
    validator = Validator(MockProvider(response))

    with pytest.raises(ValidatorError, match=r"0 verdict.*1 extracted identifier"):
        validator.run(_MODULE, [_UNIQUE_HTML])


def test_run_short_circuits_when_module_has_no_extracted_data() -> None:
    """A module with no extracted_data validates without calling the LLM.

    The MockProvider is configured with an unparsable response, so the
    absence of a ValidatorError proves the LLM was never called.
    """
    validator = Validator(MockProvider("not valid json"))

    result = validator.run(_EMPTY_MODULE, ["<html></html>"])

    assert result.is_valid is True
    assert result.verdicts == []


def _check_all_pass(result: ValidationResult) -> None:
    assert result.feedback == ""


def _check_one_fails(result: ValidationResult) -> None:
    assert "#a" not in result.feedback
    assert "#b: not found" in result.feedback


@pytest.mark.parametrize(
    ("verdicts", "expected_is_valid", "check"),
    [
        ([("#a", True, "ok"), ("#b", True, "ok")], True, _check_all_pass),
        ([], True, _check_all_pass),
        ([("#a", True, "ok"), ("#b", False, "not found")], False, _check_one_fails),
    ],
    ids=["all_pass", "no_verdicts", "one_fails"],
)
def test_is_valid_and_feedback(
    verdicts: list[tuple[str, bool, str]],
    expected_is_valid: bool,
    check: Callable[[ValidationResult], None],
) -> None:
    """is_valid reflects every verdict; feedback lists only the failed ones."""
    result = ValidationResult(
        verdicts=[
            IdentifierVerdict(identifier_tracking=t, is_valid=v, reason=r)
            for t, v, r in verdicts
        ]
    )

    assert result.is_valid is expected_is_valid
    check(result)


@pytest.mark.parametrize(
    ("html", "expected_reason_substring"),
    [
        (_DUPLICATE_HTML, "resolves to 2 elements"),
        ("<html></html>", "resolves to 0 elements"),
        ("<div data-qa='login-button'>Login</div>", "tag/role"),
    ],
    ids=["multiple_matches", "no_matches", "implausible_tag"],
)
def test_run_vetoes_an_llm_approved_identifier_that_fails_a_deterministic_check(
    html: str, expected_reason_substring: str
) -> None:
    """An LLM-approved identifier that isn't unique or plausible is vetoed."""
    validator = Validator(MockProvider(_VALID_RESPONSE))

    result = validator.run(_MODULE, [html])

    assert result.is_valid is False
    assert expected_reason_substring in result.verdicts[0].reason


def test_run_does_not_override_an_already_invalid_verdict() -> None:
    """The deterministic veto never rescues or rewrites an already-invalid verdict."""
    response = json.dumps(
        {
            "verdicts": [
                {
                    "identifier_tracking": "[data-qa='login-button']",
                    "is_valid": False,
                    "reason": "wrong element type",
                }
            ]
        }
    )
    validator = Validator(MockProvider(response))

    result = validator.run(_MODULE, [_UNIQUE_HTML])

    assert result.is_valid is False
    assert result.verdicts[0].reason == "wrong element type"


def test_run_normalizes_identifier_tracking_to_the_module_ground_truth() -> None:
    """The merged verdict's identifier_tracking always matches the module's.

    Matching an LLM verdict to an identifier is positional, not by string,
    so a verdict is normalized to the module's value even if the LLM's
    echoed string drifted.
    """
    response = json.dumps(
        {
            "verdicts": [
                {
                    "identifier_tracking": "some other string",
                    "is_valid": True,
                    "reason": "looks fine",
                }
            ]
        }
    )
    validator = Validator(MockProvider(response))

    result = validator.run(_MODULE, [_UNIQUE_HTML])

    assert result.verdicts[0].identifier_tracking == "[data-qa='login-button']"


def test_run_uses_per_step_html_snapshot_for_each_identifier() -> None:
    """Each identifier is checked against its own step's HTML snapshot.

    Simulates a module recovered via replay: step 0's button only exists in
    the first snapshot, step 1's message only exists in the second. Checking
    either identifier against the wrong snapshot would wrongly veto it.
    """
    message_data = ExtractedData(
        type="text",
        request_description="The error message",
        identifier_type="css",
        identifier_tracking=".error-message",
    )
    module = Module(
        url="https://automationexercise.com/login",
        description="Login page",
        execution_steps=[
            ExecutionStep(step="Click the Login button", extracted_data=[_EXTRACTED]),
            ExecutionStep(
                step="Verify the error message", extracted_data=[message_data]
            ),
        ],
    )
    response = json.dumps(
        {
            "verdicts": [
                {
                    "identifier_tracking": "[data-qa='login-button']",
                    "is_valid": True,
                    "reason": "ok",
                },
                {
                    "identifier_tracking": ".error-message",
                    "is_valid": True,
                    "reason": "ok",
                },
            ]
        }
    )
    validator = Validator(MockProvider(response))
    html_by_step = [_UNIQUE_HTML, "<div class='error-message'>Incorrect!</div>"]

    result = validator.run(module, html_by_step)

    assert result.is_valid is True


@pytest.mark.parametrize(
    ("html_by_step", "expect_labels"),
    [
        ([_UNIQUE_HTML], False),
        ([_UNIQUE_HTML, "<div class='error-message'>Incorrect!</div>"], True),
    ],
    ids=["single_snapshot_unlabeled", "distinct_snapshots_labeled"],
)
def test_render_html_sections(html_by_step: list[str], expect_labels: bool) -> None:
    """A single shared snapshot renders unlabeled; distinct ones are labeled."""
    captured: dict[str, str] = {}

    def capture(_system_prompt: str, user_prompt: str) -> str:
        captured["prompt"] = user_prompt
        return _VALID_RESPONSE

    validator = Validator(MockProvider(capture))

    validator.run(_MODULE, html_by_step)

    for html in html_by_step:
        assert html in captured["prompt"]
    if expect_labels:
        assert "Page HTML snapshot 0" in captured["prompt"]
        assert "Page HTML snapshot 1" in captured["prompt"]
    else:
        assert "Page HTML snapshot" not in captured["prompt"]
