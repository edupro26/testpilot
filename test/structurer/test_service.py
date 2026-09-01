"""Tests for src.structurer.service."""

import json

import pytest
from src.exceptions import StructurerError
from src.llm.provider.mock import MockProvider
from src.structurer.service import Structurer

_VALID_RESPONSE = json.dumps(
    {
        "name": "Login User with Incorrect Credentials",
        "modules": [
            {
                "url": "https://automationexercise.com",
                "description": "Reach the login page",
                "execution_steps": [{"step": "Click Signup / Login"}],
            }
        ],
    }
)


def test_run_returns_test_case_for_valid_llm_response() -> None:
    """A well-formed JSON response is parsed into a TestCase."""
    structurer = Structurer(MockProvider(_VALID_RESPONSE))

    test_case = structurer.run("# Login User with Incorrect Credentials")

    assert test_case.name == "Login User with Incorrect Credentials"
    assert test_case.modules[0].url == "https://automationexercise.com"


def test_run_raises_structurer_error_for_malformed_json() -> None:
    """A non-JSON response raises StructurerError, not a raw JSONDecodeError."""
    structurer = Structurer(MockProvider("not valid json"))

    with pytest.raises(StructurerError, match="not valid JSON"):
        structurer.run("# Some test case")


def test_run_raises_structurer_error_for_schema_mismatch() -> None:
    """Valid JSON that doesn't match the TestCase shape raises StructurerError."""
    structurer = Structurer(MockProvider(json.dumps({"unexpected": "shape"})))

    with pytest.raises(StructurerError, match="did not match the TestCase shape"):
        structurer.run("# Some test case")
