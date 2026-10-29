"""Tests for src.model.test_case."""

import pytest
from pydantic import ValidationError
from src.model.test_case import ExecutionStep, Module, StepStatement, TestCase

_CONSENT = 'page.get_by_role("button", name="Consent").click()'
_CLICK = 'page.get_by_role("link", name="Signup / Login").click()'

_STRUCTURED_PAYLOAD = {
    "name": "Login User with Incorrect Credentials",
    "modules": [
        {
            "url": "https://automationexercise.com/login",
            "description": "Reach the login page",
            "execution_steps": [{"step": "Click Signup / Login"}],
        }
    ],
}

_VALIDATED_PAYLOAD = {
    "name": "Login User with Incorrect Credentials",
    "modules": [
        {
            "url": "https://automationexercise.com/login",
            "description": "Reach the login page",
            "execution_steps": [
                {
                    "step": "Click Signup / Login",
                    "statements": [
                        {
                            "code": _CONSENT,
                        },
                        {
                            "code": _CLICK,
                        },
                    ],
                }
            ],
        }
    ],
}


def test_structured_payload_parses_with_no_statements() -> None:
    """The Structurer's output is the same schema, minus the statements."""
    test_case = TestCase.model_validate(_STRUCTURED_PAYLOAD)

    assert test_case.modules[0].execution_steps[0].statements == []


def test_validated_payload_parses() -> None:
    """The Extractor's output round-trips through the same model."""
    test_case = TestCase.model_validate(_VALIDATED_PAYLOAD)
    statements = test_case.modules[0].execution_steps[0].statements

    assert [s.code for s in statements] == [_CONSENT, _CLICK]


def test_reason_defaults_to_empty_until_validated() -> None:
    """The Extractor builds statements before the Validator has a reason."""
    assert StepStatement(code="page.goto('/')").reason == ""


def test_code_is_required() -> None:
    """A statement with no code is not a statement."""
    with pytest.raises(ValidationError):
        StepStatement(reason="r")  # type: ignore[call-arg]


def test_round_trips_through_json() -> None:
    """The validated JSON is persisted and re-read, so this must hold."""
    original = TestCase.model_validate(_VALIDATED_PAYLOAD)

    assert TestCase.model_validate_json(original.model_dump_json()) == original


def test_module_requires_its_steps() -> None:
    """A module with no steps is a structuring failure, not a valid module."""
    with pytest.raises(ValidationError):
        Module(url="https://example.com", description="d")


def test_execution_step_requires_its_text() -> None:
    """Statements are always traceable back to the step that produced them."""
    with pytest.raises(ValidationError):
        ExecutionStep(statements=[])
