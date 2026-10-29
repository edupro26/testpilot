"""Shared pytest fixtures."""

from pathlib import Path

import pytest

_SETTINGS_ENV_VARS = (
    "LLM_PROVIDER",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_DEPLOYMENT_NAME",
    "AZURE_MODEL_NAME",
    "OPENAI_API_VERSION",
    "MCP_URL",
    "MCP_MAX_TURNS",
    "LOG_LEVEL",
)


@pytest.fixture
def isolated_settings_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Isolate Settings() from the real environment and any local .env file."""
    for key in _SETTINGS_ENV_VARS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.chdir(tmp_path)
