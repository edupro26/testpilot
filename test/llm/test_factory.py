"""Tests for src.llm.factory."""

import pytest
from src.config import Settings
from src.llm.factory import get_llm_provider
from src.llm.provider.anthropic import AnthropicProvider
from src.llm.provider.azure_openai import AzureOpenAIProvider
from src.llm.provider.mock import MockProvider
from src.llm.provider.openai import OpenAIProvider
from src.llm.retry import RetryingLLMProvider

_PROVIDER_CASES = [
    ("mock", {}, MockProvider),
    (
        "azure_openai",
        {
            "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
            "AZURE_OPENAI_API_KEY": "fake-key",
            "AZURE_DEPLOYMENT_NAME": "fake-deployment",
            "OPENAI_API_VERSION": "2025-04-01-preview",
        },
        AzureOpenAIProvider,
    ),
    (
        "openai",
        {"OPENAI_API_KEY": "fake-key", "OPENAI_MODEL": "gpt-5.6-luna"},
        OpenAIProvider,
    ),
    (
        "anthropic",
        {"ANTHROPIC_API_KEY": "fake-key", "ANTHROPIC_MODEL": "claude-4.6-sonnet"},
        AnthropicProvider,
    ),
]


@pytest.mark.usefixtures("isolated_settings_env")
@pytest.mark.parametrize(
    ("llm_provider", "extra_env", "expected_type"),
    _PROVIDER_CASES,
    ids=[case[0] for case in _PROVIDER_CASES],
)
def test_get_llm_provider_returns_the_configured_provider_wrapped_in_retry(
    monkeypatch: pytest.MonkeyPatch,
    llm_provider: str,
    extra_env: dict[str, str],
    expected_type: type,
) -> None:
    """Every fully-configured provider comes back wrapped in retry protection."""
    monkeypatch.setenv("LLM_PROVIDER", llm_provider)
    for key, value in extra_env.items():
        monkeypatch.setenv(key, value)

    provider = get_llm_provider(Settings())

    assert isinstance(provider, RetryingLLMProvider)
    assert isinstance(provider.provider, expected_type)


@pytest.mark.usefixtures("isolated_settings_env")
@pytest.mark.parametrize(
    ("llm_provider", "missing_key"),
    [
        ("azure_openai", "AZURE_OPENAI_ENDPOINT"),
        ("openai", "OPENAI_API_KEY"),
        ("anthropic", "ANTHROPIC_API_KEY"),
    ],
    ids=["azure_openai", "openai", "anthropic"],
)
def test_get_llm_provider_missing_config_raises(
    monkeypatch: pytest.MonkeyPatch, llm_provider: str, missing_key: str
) -> None:
    """A real provider without its required credentials raises ValueError."""
    monkeypatch.setenv("LLM_PROVIDER", llm_provider)

    with pytest.raises(ValueError, match=f"Missing required {missing_key}"):
        get_llm_provider(Settings())
