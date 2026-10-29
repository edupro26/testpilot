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


def _azure(
    monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture, content: str | None
) -> tuple[AzureOpenAIProvider, MagicMock]:
    """Build an Azure provider whose SDK client returns `content`."""
    for key, value in _AZURE_ENV.items():
        monkeypatch.setenv(key, value)
    client = mocker.patch("src.llm.provider.azure_openai.AzureOpenAI").return_value
    client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content=content))]
    )
    return AzureOpenAIProvider(Settings()), client


@pytest.mark.usefixtures("isolated_settings_env")
def test_azure_missing_settings_raises(mocker: MockerFixture) -> None:
    """Constructing the provider without its required settings raises."""
    mocker.patch("src.llm.provider.azure_openai.AzureOpenAI")

    with pytest.raises(ValueError, match="Missing required AZURE_OPENAI_ENDPOINT"):
        AzureOpenAIProvider(Settings())


@pytest.mark.usefixtures("isolated_settings_env")
def test_azure_complete_returns_response_text(
    monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """complete() extracts and returns the model's response text."""
    provider, _ = _azure(monkeypatch, mocker, "hello")

    assert provider.complete(system_prompt="sys", user_prompt="user") == "hello"


@pytest.mark.usefixtures("isolated_settings_env")
def test_azure_routes_by_deployment_and_sends_the_model_name(
    monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """The deployment is pinned in the client, so `model` can carry the name."""
    for key, value in _AZURE_ENV.items():
        monkeypatch.setenv(key, value)
    azure_cls = mocker.patch("src.llm.provider.azure_openai.AzureOpenAI")
    client = azure_cls.return_value

    AzureOpenAIProvider(Settings()).complete(system_prompt="sys", user_prompt="u")

    assert azure_cls.call_args.kwargs["azure_deployment"] == "fake-deployment"
    assert client.chat.completions.create.call_args.kwargs["model"] == "fake-model"


@pytest.mark.usefixtures("isolated_settings_env")
def test_azure_complete_returns_empty_string_when_content_is_missing(
    monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """A missing response is normalized to an empty string."""
    provider, _ = _azure(monkeypatch, mocker, None)

    assert provider.complete(system_prompt="sys", user_prompt="user") == ""


@pytest.mark.usefixtures("isolated_settings_env")
def test_azure_json_mode_toggles_json_request(
    monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """json_mode controls whether a JSON-only response is requested."""
    provider, client = _azure(monkeypatch, mocker, "hello")

    provider.complete(system_prompt="sys", user_prompt="user")
    assert "response_format" not in client.chat.completions.create.call_args.kwargs

    provider.complete(system_prompt="sys", user_prompt="user", json_mode=True)
    assert client.chat.completions.create.call_args.kwargs["response_format"] == {
        "type": "json_object"
    }


def test_mock_provider_returns_fixed_response() -> None:
    """A fixed string response is returned as-is."""
    provider = MockProvider("canned response")

    result = provider.complete(system_prompt="sys", user_prompt="user")

    assert result == "canned response"


def test_mock_provider_returns_computed_response() -> None:
    """A callable response is invoked with the system and user prompts."""
    provider = MockProvider(
        lambda system_prompt, user_prompt: f"{system_prompt}:{user_prompt}"
    )

    result = provider.complete(system_prompt="sys", user_prompt="user")

    assert result == "sys:user"


def test_mock_provider_default_response_is_empty() -> None:
    """With no response configured, complete() returns an empty string."""
    provider = MockProvider()

    assert provider.complete(system_prompt="sys", user_prompt="user") == ""
