"""Tests for the network-backed LLMProvider implementations.

AzureOpenAIProvider, OpenAIProvider, and AnthropicProvider all satisfy the
same LLMProvider contract, so they're exercised through one parametrized
suite instead of a separate test file per provider. MockProvider has no
network client to mock, so it's tested separately below.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest
from pytest_mock import MockerFixture
from src.config import Settings
from src.llm.protocol import LLMProvider
from src.llm.provider.anthropic import AnthropicProvider
from src.llm.provider.azure_openai import AzureOpenAIProvider
from src.llm.provider.mock import MockProvider
from src.llm.provider.openai import OpenAIProvider


@dataclass
class ProviderCase:
    """A concrete provider's settings, mocked SDK client, and I/O shape."""

    name: str
    provider_cls: Callable[[Settings], LLMProvider]
    env: dict[str, str]
    patch_target: str
    configure_response: Callable[[MagicMock, str | None], None]
    call_kwargs: Callable[[MagicMock], dict[str, Any]]
    used_json_mode: Callable[[dict[str, Any]], bool]
    missing_settings_match: str


def _configure_openai_style(mock_client: MagicMock, content: str | None) -> None:
    """Set up an openai-SDK-shaped chat completion response."""
    mock_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content=content))]
    )


def _openai_style_kwargs(mock_client: MagicMock) -> dict[str, Any]:
    """Return the kwargs from the client's last chat completion call."""
    _, kwargs = mock_client.chat.completions.create.call_args
    return kwargs


def _openai_style_used_json_mode(kwargs: dict[str, Any]) -> bool:
    """Return whether an openai-style call requested a JSON response."""
    return kwargs.get("response_format") == {"type": "json_object"}


def _configure_anthropic(mock_client: MagicMock, content: str | None) -> None:
    """Set up an Anthropic-SDK-shaped messages response."""
    blocks = [MagicMock(text=content)] if content is not None else []
    mock_client.messages.create.return_value = MagicMock(content=blocks)


def _anthropic_kwargs(mock_client: MagicMock) -> dict[str, Any]:
    """Return the kwargs from the client's last messages.create() call."""
    _, kwargs = mock_client.messages.create.call_args
    return kwargs


def _anthropic_used_json_mode(kwargs: dict[str, Any]) -> bool:
    """Return whether Anthropic's system prompt carries the JSON hint."""
    return "JSON" in kwargs["system"]


CASES = [
    ProviderCase(
        name="azure_openai",
        provider_cls=AzureOpenAIProvider,
        env={
            "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
            "AZURE_OPENAI_API_KEY": "fake-key",
            "AZURE_DEPLOYMENT_NAME": "fake-deployment",
            "OPENAI_API_VERSION": "2025-04-01-preview",
        },
        patch_target="src.llm.provider.azure_openai.AzureOpenAI",
        configure_response=_configure_openai_style,
        call_kwargs=_openai_style_kwargs,
        used_json_mode=_openai_style_used_json_mode,
        missing_settings_match="Missing required Azure OpenAI settings",
    ),
    ProviderCase(
        name="openai",
        provider_cls=OpenAIProvider,
        env={"OPENAI_API_KEY": "fake-key", "OPENAI_MODEL": "gpt-5.6-luna"},
        patch_target="src.llm.provider.openai.OpenAI",
        configure_response=_configure_openai_style,
        call_kwargs=_openai_style_kwargs,
        used_json_mode=_openai_style_used_json_mode,
        missing_settings_match="Missing required OpenAI settings",
    ),
    ProviderCase(
        name="anthropic",
        provider_cls=AnthropicProvider,
        env={"ANTHROPIC_API_KEY": "fake-key", "ANTHROPIC_MODEL": "claude-4.6-sonnet"},
        patch_target="src.llm.provider.anthropic.Anthropic",
        configure_response=_configure_anthropic,
        call_kwargs=_anthropic_kwargs,
        used_json_mode=_anthropic_used_json_mode,
        missing_settings_match="Missing required Anthropic settings",
    ),
]


def _build_provider(
    case: ProviderCase, monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> tuple[LLMProvider, MagicMock]:
    """Construct `case`'s provider with a fully mocked SDK client."""
    for key, value in case.env.items():
        monkeypatch.setenv(key, value)
    mock_client = mocker.patch(case.patch_target).return_value
    return case.provider_cls(Settings()), mock_client


@pytest.mark.usefixtures("isolated_settings_env")
@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_missing_settings_raises(case: ProviderCase, mocker: MockerFixture) -> None:
    """Constructing a provider without its required settings raises."""
    mocker.patch(case.patch_target)

    with pytest.raises(ValueError, match=case.missing_settings_match):
        case.provider_cls(Settings())


@pytest.mark.usefixtures("isolated_settings_env")
@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_complete_returns_response_text(
    case: ProviderCase, monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """complete() extracts and returns the model's response text."""
    provider, mock_client = _build_provider(case, monkeypatch, mocker)
    case.configure_response(mock_client, "hello")

    result = provider.complete(system_prompt="sys", user_prompt="user")

    assert result == "hello"


@pytest.mark.usefixtures("isolated_settings_env")
@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_complete_returns_empty_string_when_content_is_missing(
    case: ProviderCase, monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """A missing/None response is normalized to an empty string."""
    provider, mock_client = _build_provider(case, monkeypatch, mocker)
    case.configure_response(mock_client, None)

    result = provider.complete(system_prompt="sys", user_prompt="user")

    assert result == ""


@pytest.mark.usefixtures("isolated_settings_env")
@pytest.mark.parametrize("case", CASES, ids=lambda c: c.name)
def test_json_mode_toggles_json_request(
    case: ProviderCase, monkeypatch: pytest.MonkeyPatch, mocker: MockerFixture
) -> None:
    """json_mode controls whether a JSON-only request is sent."""
    provider, mock_client = _build_provider(case, monkeypatch, mocker)
    case.configure_response(mock_client, "hello")

    provider.complete(system_prompt="sys", user_prompt="user")
    assert not case.used_json_mode(case.call_kwargs(mock_client))

    provider.complete(system_prompt="sys", user_prompt="user", json_mode=True)
    assert case.used_json_mode(case.call_kwargs(mock_client))


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
