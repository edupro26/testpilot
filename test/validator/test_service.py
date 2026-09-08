"""Tests for src.validator.service."""

import json

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


def test_run_returns_validation_result_for_valid_llm_response() -> None:
    """A well-formed JSON response is parsed into a ValidationResult."""
    validator = Validator(MockProvider(_VALID_RESPONSE))

    result = validator.run(_MODULE, "<html>...</html>")

    assert result.is_valid is True
    assert result.verdicts[0].identifier_tracking == "[data-qa='login-button']"


def test_run_raises_validator_error_for_malformed_json() -> None:
    """A non-JSON response raises ValidatorError, not a raw JSONDecodeError."""
    validator = Validator(MockProvider("not valid json"))

    with pytest.raises(ValidatorError, match="not valid JSON"):
        validator.run(_MODULE, "<html></html>")


def test_run_raises_validator_error_for_schema_mismatch() -> None:
    """Valid JSON not matching the ValidationResult shape raises ValidatorError."""
    malformed = json.dumps({"verdicts": [{"identifier_tracking": "x"}]})
    validator = Validator(MockProvider(malformed))

    with pytest.raises(ValidatorError, match="did not match"):
        validator.run(_MODULE, "<html></html>")


def test_run_short_circuits_when_module_has_no_extracted_data() -> None:
    """A module with no extracted_data validates without calling the LLM.

    The MockProvider is configured with an unparsable response, so the
    absence of a ValidatorError proves the LLM was never called.
    """
    validator = Validator(MockProvider("not valid json"))

    result = validator.run(_EMPTY_MODULE, "<html></html>")

    assert result.is_valid is True
    assert result.verdicts == []


def test_is_valid_true_when_all_verdicts_pass() -> None:
    """is_valid is True when every verdict passed."""
    result = ValidationResult(
        verdicts=[
            IdentifierVerdict(identifier_tracking="#a", is_valid=True, reason="ok"),
            IdentifierVerdict(identifier_tracking="#b", is_valid=True, reason="ok"),
        ]
    )

    assert result.is_valid is True
    assert result.feedback == ""


def test_is_valid_true_with_no_verdicts() -> None:
    """is_valid is vacuously True when there are no verdicts to check."""
    result = ValidationResult()

    assert result.is_valid is True
    assert result.feedback == ""


def test_is_valid_false_when_any_verdict_fails() -> None:
    """is_valid is False if a single verdict failed."""
    result = ValidationResult(
        verdicts=[
            IdentifierVerdict(identifier_tracking="#a", is_valid=True, reason="ok"),
            IdentifierVerdict(
                identifier_tracking="#b", is_valid=False, reason="not found"
            ),
        ]
    )

    assert result.is_valid is False


def test_feedback_lists_only_failed_identifiers() -> None:
    """Feedback summarizes failed verdicts only, not passing ones."""
    result = ValidationResult(
        verdicts=[
            IdentifierVerdict(identifier_tracking="#a", is_valid=True, reason="ok"),
            IdentifierVerdict(
                identifier_tracking="#b", is_valid=False, reason="not found"
            ),
        ]
    )

    assert "#a" not in result.feedback
    assert "#b: not found" in result.feedback
