"""Tests for src.model.test_case."""

from collections.abc import Callable

import pytest
from pydantic import ValidationError
from src.model.enums import ElementType, IdentifierType
from src.model.test_case import ExecutionStep, ExtractedData, Module, TestCase

_LEVEL_1_PAYLOAD = {
    "name": "Login User with Incorrect Credentials",
    "modules": [
        {
            "url": "https://automationexercise.com/login",
            "description": "Reach the login page",
            "execution_steps": [{"step": "Click Signup / Login"}],
        }
    ],
}

_LEVEL_2_PAYLOAD = {
    "name": "Login User with Incorrect Credentials",
    "modules": [
        {
            "url": "https://automationexercise.com/login",
            "description": "Reach the login page",
            "execution_steps": [
                {
                    "step": "Click Login",
                    "extracted_data": [
                        {
                            "type": "button",
                            "request_description": "The Login button",
                            "identifier_type": "css",
                            "identifier_tracking": "[data-qa='login-button']",
                        },
                        {
                            "type": "input",
                            "request_description": "The email field",
                            "identifier_type": "id",
                            "identifier_tracking": "email",
                            "input_value": "notarealuser@example.com",
                        },
                    ],
                }
            ],
        }
    ],
}


def _check_level_1(test_case: TestCase) -> None:
    step = test_case.modules[0].execution_steps[0]
    assert isinstance(test_case.modules[0], Module)
    assert isinstance(step, ExecutionStep)
    assert step.extracted_data == []


def _check_level_2(test_case: TestCase) -> None:
    button, email_input = test_case.modules[0].execution_steps[0].extracted_data
    assert isinstance(button, ExtractedData)
    assert button.type == ElementType.BUTTON
    assert button.identifier_type == IdentifierType.CSS
    assert button.input_value is None
    assert email_input.type == ElementType.INPUT
    assert email_input.input_value == "notarealuser@example.com"


@pytest.mark.parametrize(
    ("payload", "check"),
    [(_LEVEL_1_PAYLOAD, _check_level_1), (_LEVEL_2_PAYLOAD, _check_level_2)],
    ids=["level_1_empty_extracted_data", "level_2_populated_extracted_data"],
)
def test_test_case_round_trips_valid_data(
    payload: dict, check: Callable[[TestCase], None]
) -> None:
    """Both Level 1 (empty extracted_data) and Level 2 (populated) payloads validate."""
    test_case = TestCase.model_validate(payload)

    assert test_case.name == payload["name"]
    check(test_case)


@pytest.mark.parametrize(
    "incomplete_payload",
    [
        {"name": "Missing modules"},
        {
            "name": "Missing execution_steps",
            "modules": [{"url": "https://x.com", "description": "d"}],
        },
    ],
    ids=["missing_modules", "missing_execution_steps"],
)
def test_test_case_missing_required_field_raises(incomplete_payload: dict) -> None:
    """Omitting a required field (modules, or a module's execution_steps) raises."""
    with pytest.raises(ValidationError):
        TestCase.model_validate(incomplete_payload)


@pytest.mark.parametrize(
    ("field", "value"),
    [("type", "unknown"), ("identifier_type", "unknown")],
    ids=["unknown_type", "unknown_identifier_type"],
)
def test_extracted_data_rejects_unknown_enum_value(field: str, value: str) -> None:
    """A type/identifier_type value outside its enum raises ValidationError."""
    payload = {
        "type": "button",
        "request_description": "Some element",
        "identifier_type": "css",
        "identifier_tracking": ".some-class",
        field: value,
    }

    with pytest.raises(ValidationError):
        ExtractedData.model_validate(payload)


def test_extracted_data_id_identifier_is_the_bare_attribute_value() -> None:
    """An "id" identifier_type carries the bare id value, no leading '#'.

    Pins the format contract documented in resources/prompts/extractor.md,
    which the Level 3 Generator will rely on to build a Playwright
    `id=<value>` locator.
    """
    extracted = ExtractedData.model_validate(
        {
            "type": "button",
            "request_description": "The submit button",
            "identifier_type": "id",
            "identifier_tracking": "submit",
        }
    )

    assert extracted.identifier_type == IdentifierType.ID
    assert extracted.identifier_tracking == "submit"
