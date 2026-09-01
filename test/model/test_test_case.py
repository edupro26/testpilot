"""Tests for src.model.test_case."""

import pytest
from pydantic import ValidationError
from src.model.test_case import ExecutionStep, Module, TestCase


def test_test_case_round_trips_valid_data() -> None:
    """A well-formed Level 1 payload validates into the expected shape."""
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


def test_execution_step_defaults_extracted_data_to_empty_list() -> None:
    """extracted_data defaults to an empty list when omitted."""
    step = ExecutionStep.model_validate({"step": "Click Login"})

    assert step.extracted_data == []


def test_test_case_missing_required_field_raises() -> None:
    """Omitting a required field (e.g. modules) raises ValidationError."""
    with pytest.raises(ValidationError):
        TestCase.model_validate({"name": "Missing modules"})
