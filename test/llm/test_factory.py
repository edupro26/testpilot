"""Tests for src.llm.factory."""

import pytest
from src.config import Settings
from src.llm.factory import get_llm_provider
from src.llm.provider.anthropic import AnthropicProvider
from src.llm.provider.azure_openai import AzureOpenAIProvider
from src.llm.provider.mock import MockProvider
from src.llm.provider.openai import OpenAIProvider


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_returns_mock_by_default() -> None:
    """With no LLM_PROVIDER set, the mock provider is returned."""
    provider = get_llm_provider(Settings())

    assert isinstance(provider, MockProvider)


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_returns_azure_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM_PROVIDER=azure_openai with full config returns an Azure provider."""
    monkeypatch.setenv("LLM_PROVIDER", "azure_openai")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "fake-key")
    monkeypatch.setenv("AZURE_DEPLOYMENT_NAME", "fake-deployment")
    monkeypatch.setenv("OPENAI_API_VERSION", "2025-04-01-preview")

    provider = get_llm_provider(Settings())

    assert isinstance(provider, AzureOpenAIProvider)


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_azure_openai_missing_config_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """LLM_PROVIDER=azure_openai without credentials raises ValueError."""
    monkeypatch.setenv("LLM_PROVIDER", "azure_openai")

    with pytest.raises(ValueError, match="Missing required Azure OpenAI settings"):
        get_llm_provider(Settings())


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_returns_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM_PROVIDER=openai with full config returns an OpenAI provider."""
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "fake-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.6-luna")

    provider = get_llm_provider(Settings())

    assert isinstance(provider, OpenAIProvider)


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_openai_missing_config_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """LLM_PROVIDER=openai without credentials raises ValueError."""
    monkeypatch.setenv("LLM_PROVIDER", "openai")

    with pytest.raises(ValueError, match="Missing required OpenAI settings"):
        get_llm_provider(Settings())


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_returns_anthropic(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM_PROVIDER=anthropic with full config returns an Anthropic provider."""
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-4.6-sonnet")

    provider = get_llm_provider(Settings())

    assert isinstance(provider, AnthropicProvider)


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_anthropic_missing_config_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """LLM_PROVIDER=anthropic without credentials raises ValueError."""
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")

    with pytest.raises(ValueError, match="Missing required Anthropic settings"):
        get_llm_provider(Settings())
