"""Tests for src.llm.factory."""

import pytest
from src.config import Settings
from src.llm.factory import get_llm_provider
from src.llm.provider.azure_openai import AzureOpenAIProvider
from src.llm.provider.mock import MockProvider
from src.llm.retry import RetryingLLMProvider

_AZURE_ENV = {
    "AZURE_OPENAI_ENDPOINT": "https://example.openai.azure.com",
    "AZURE_OPENAI_API_KEY": "fake-key",
    "AZURE_DEPLOYMENT_NAME": "fake-deployment",
    "AZURE_MODEL_NAME": "fake-model",
    "OPENAI_API_VERSION": "2025-04-01-preview",
}


@pytest.mark.usefixtures("isolated_settings_env")
def test_get_llm_provider_builds_the_configured_provider_wrapped_in_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mock is the default; a real provider needs its credentials.

    Every provider comes back wrapped in retry protection.
    """
    provider = get_llm_provider(Settings())
    assert isinstance(provider, RetryingLLMProvider)
    assert isinstance(provider.provider, MockProvider)

    monkeypatch.setenv("LLM_PROVIDER", "azure_openai")
    with pytest.raises(ValueError, match="Missing required AZURE_OPENAI_ENDPOINT"):
        get_llm_provider(Settings())

    for key, value in _AZURE_ENV.items():
        monkeypatch.setenv(key, value)
    provider = get_llm_provider(Settings())
    assert isinstance(provider, RetryingLLMProvider)
    assert isinstance(provider.provider, AzureOpenAIProvider)
