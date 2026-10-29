"""Tests for src.model.test_case."""

import pytest
from pydantic import ValidationError
from src.model.test_case import ExecutionStep, Module, StepStatement, TestCase

_CONSENT = 'page.get_by_role("button", name="Consent").click()'
_CLICK = 'page.get_by_role("link", name="Signup / Login").click()'


def _payload(statements: list[dict] | None = None) -> dict:
    step: dict = {"step": "Click Signup / Login"}
    if statements is not None:
        step["statements"] = statements
    return {
        "name": "Login User with Incorrect Credentials",
        "modules": [
            {
                "url": "https://automationexercise.com/login",
                "description": "Reach the login page",
                "execution_steps": [step],
            }
        ],
    }


def test_one_schema_carries_the_test_case_through_every_stage() -> None:
    """Structured (no statements) and validated payloads share the model.

    The validated one is persisted and re-read, so it must round-trip.
    """
    structured = TestCase.model_validate(_payload())
    assert structured.modules[0].execution_steps[0].statements == []

    validated = TestCase.model_validate(
        _payload([{"code": _CONSENT}, {"code": _CLICK}])
    )
    statements = validated.modules[0].execution_steps[0].statements
    assert [s.code for s in statements] == [_CONSENT, _CLICK]
    assert statements[0].reason == ""

    assert TestCase.model_validate_json(validated.model_dump_json()) == validated


def test_incomplete_parts_are_rejected() -> None:
    """A statement needs code, a step its text, and a module its steps."""
    with pytest.raises(ValidationError):
        StepStatement(reason="r")  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        ExecutionStep(statements=[])  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        Module(url="https://example.com", description="d")  # type: ignore[call-arg]
