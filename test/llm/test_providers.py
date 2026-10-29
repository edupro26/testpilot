"""Tests for the LLMProvider implementations."""

from unittest.mock import MagicMock

import pytest
from pytest_mock import MockerFixture
from src.config import Settings
from src.llm.provider.azure_openai import AzureOpenAIProvider
from src.llm.provider.mock import MockProvider

_AZURE_ENV = {
    "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
    "AZURE_OPENAI_API_KEY": "fake-key",
    "AZURE_DEPLOYMENT_NAME": "fake-deployment",
    "AZURE_MODEL_NAME": "fake-model",
    "OPENAI_API_VERSION": "2025-04-01-preview",
}


@pytest.mark.usefixtures("isolated_settings_env")
def test_azure_complete_sends_the_request_and_returns_the_text(
    monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """The deployment is pinned in the client, so `model` carries the name.

    json_mode toggles a JSON-only response, and missing content is
    normalized to an empty string.
    """
    for key, value in _AZURE_ENV.items():
        monkeypatch.setenv(key, value)
    azure_cls = mocker.patch("src.llm.provider.azure_openai.AzureOpenAI")
    create = azure_cls.return_value.chat.completions.create
    create.return_value = MagicMock(choices=[MagicMock(message=MagicMock())])
    provider = AzureOpenAIProvider(Settings())

    create.return_value.choices[0].message.content = "hello"
    assert provider.complete(system_prompt="sys", user_prompt="user") == "hello"
    assert azure_cls.call_args.kwargs["azure_deployment"] == "fake-deployment"
    assert create.call_args.kwargs["model"] == "fake-model"
    assert "response_format" not in create.call_args.kwargs

    create.return_value.choices[0].message.content = None
    assert provider.complete(system_prompt="s", user_prompt="u", json_mode=True) == ""
    assert create.call_args.kwargs["response_format"] == {"type": "json_object"}


def test_mock_provider_returns_fixed_or_computed_responses() -> None:
    """A string is returned as-is, a callable gets both prompts, default is ''."""
    fixed = MockProvider("canned response")
    computed = MockProvider(lambda system, user: f"{system}:{user}")

    assert fixed.complete(system_prompt="sys", user_prompt="user") == "canned response"
    assert computed.complete(system_prompt="sys", user_prompt="user") == "sys:user"
    assert MockProvider().complete(system_prompt="sys", user_prompt="user") == ""
