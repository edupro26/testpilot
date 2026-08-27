"""Tests for src.config."""

import pytest
from src.config import LLMProviderName, Settings


@pytest.mark.usefixtures("isolated_settings_env")
def test_settings_defaults_to_mock_provider() -> None:
    """Settings() defaults to the mock LLM provider when unconfigured."""
    settings = Settings()

    assert settings.llm_provider == LLMProviderName.MOCK
    assert settings.log_level == "INFO"


@pytest.mark.usefixtures("isolated_settings_env")
def test_settings_reads_llm_provider_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Settings() picks up LLM_PROVIDER from the environment."""
    monkeypatch.setenv("LLM_PROVIDER", "azure_openai")

    settings = Settings()

    assert settings.llm_provider == LLMProviderName.AZURE_OPENAI
