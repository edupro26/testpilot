"""Tests for src.extractor.service."""

import json

import pytest
from src.exceptions import ExtractorError
from src.extractor.service import Extractor
from src.llm.provider.mock import MockProvider
from src.model.test_case import ExecutionStep, Module

_MODULE = Module(
    url="https://automationexercise.com/login",
    description="Login page",
    execution_steps=[ExecutionStep(step="Click the Login button")],
)

_VALID_RESPONSE = json.dumps(
    {
        "url": "https://automationexercise.com/login",
        "description": "Login page",
        "execution_steps": [
            {
                "step": "Click the Login button",
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
)


def test_run_returns_module_with_data_for_valid_llm_response() -> None:
    """A well-formed JSON response is parsed into a Module with extracted_data."""
    extractor = Extractor(MockProvider(_VALID_RESPONSE))

    result = extractor.run(_MODULE, "<html>...</html>")

    assert result.url == _MODULE.url
    assert len(result.execution_steps[0].extracted_data) == 1
    assert (
        result.execution_steps[0].extracted_data[0].identifier_tracking
        == "[data-qa='login-button']"
    )


def test_run_raises_extractor_error_for_malformed_json() -> None:
    """A non-JSON response raises ExtractorError, not a raw JSONDecodeError."""
    extractor = Extractor(MockProvider("not valid json"))

    with pytest.raises(ExtractorError, match="not valid JSON"):
        extractor.run(_MODULE, "<html></html>")


def test_run_raises_extractor_error_for_schema_mismatch() -> None:
    """Valid JSON not matching the Module shape raises ExtractorError."""
    extractor = Extractor(MockProvider(json.dumps({"unexpected": "shape"})))

    with pytest.raises(ExtractorError, match="did not match"):
        extractor.run(_MODULE, "<html></html>")


def test_run_includes_feedback_in_the_prompt_when_provided() -> None:
    """A retry's feedback text is included in the rendered prompt."""
    captured_prompts = []

    def _capture(_system_prompt: str, user_prompt: str) -> str:
        captured_prompts.append(user_prompt)
        return _VALID_RESPONSE

    extractor = Extractor(MockProvider(_capture))

    extractor.run(_MODULE, "<html></html>", feedback="The selector was wrong.")

    assert "The selector was wrong." in captured_prompts[0]


def test_run_omits_feedback_section_when_not_provided() -> None:
    """No feedback text means no feedback section leaks into the prompt."""
    captured_prompts = []

    def _capture(_system_prompt: str, user_prompt: str) -> str:
        captured_prompts.append(user_prompt)
        return _VALID_RESPONSE

    extractor = Extractor(MockProvider(_capture))

    extractor.run(_MODULE, "<html></html>")

    assert "PREVIOUS ATTEMPT FEEDBACK" not in captured_prompts[0]
