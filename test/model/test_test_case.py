"""Tests for src.model.test_case."""

import pytest
from pydantic import ValidationError
from src.model.enums import ElementType, IdentifierType
from src.model.test_case import ExecutionStep, ExtractedData, Module, TestCase


def test_test_case_round_trips_valid_data() -> None:
    """A well-formed Level 1 payload (empty extracted_data) validates."""
    test_case = TestCase.model_validate(
        {
            "name": "Login User with Incorrect Credentials",
            "modules": [
                {
                    "url": "https://automationexercise.com",
                    "description": "Reach the login page",
                    "execution_steps": [{"step": "Click Signup / Login"}],
                },
                {
                    "url": "https://automationexercise.com/login",
                    "description": "Verify login fails with incorrect credentials",
                    "execution_steps": [
                        {"step": "Enter an incorrect email and password"},
                        {"step": "Click Login"},
                        {"step": "Verify the error message is visible"},
                    ],
                },
            ],
        }
    )

    assert test_case.name == "Login User with Incorrect Credentials"
    assert len(test_case.modules) == 2
    assert isinstance(test_case.modules[0], Module)
    assert isinstance(test_case.modules[0].execution_steps[0], ExecutionStep)


def test_test_case_round_trips_populated_extracted_data() -> None:
    """A well-formed Level 2 payload (populated extracted_data) validates."""
    test_case = TestCase.model_validate(
        {
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
                                }
                            ],
                        }
                    ],
                }
            ],
        }
    )

    extracted = test_case.modules[0].execution_steps[0].extracted_data[0]
    assert isinstance(extracted, ExtractedData)
    assert extracted.type == ElementType.BUTTON
    assert extracted.identifier_type == IdentifierType.CSS


def test_execution_step_defaults_extracted_data_to_empty_list() -> None:
    """extracted_data defaults to an empty list when omitted."""
    step = ExecutionStep.model_validate({"step": "Click Login"})

    assert step.extracted_data == []


def test_test_case_missing_required_field_raises() -> None:
    """Omitting a required field (e.g. modules) raises ValidationError."""
    with pytest.raises(ValidationError):
        TestCase.model_validate({"name": "Missing modules"})


def test_extracted_data_rejects_unknown_type() -> None:
    """A type value outside ElementType raises ValidationError."""
    with pytest.raises(ValidationError):
        ExtractedData.model_validate(
            {
                "type": "unknown",
                "request_description": "Some element",
                "identifier_type": "css",
                "identifier_tracking": ".some-class",
            }
        )


def test_extracted_data_rejects_unknown_identifier_type() -> None:
    """An identifier_type value outside IdentifierType raises ValidationError."""
    with pytest.raises(ValidationError):
        ExtractedData.model_validate(
            {
                "type": "button",
                "request_description": "Some element",
                "identifier_type": "unknown",
                "identifier_tracking": ".some-class",
            }
        )


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
