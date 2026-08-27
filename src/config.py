"""Application configuration loaded from environment variables."""

import logging
from enum import StrEnum

from pydantic_settings import BaseSettings, SettingsConfigDict


class LLMProviderName(StrEnum):
    """Supported values for the LLM_PROVIDER setting."""

    MOCK = "mock"
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    AZURE_OPENAI = "azure_openai"


class Settings(BaseSettings):
    """Typed application settings loaded from the environment or .env file."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    llm_provider: LLMProviderName = LLMProviderName.MOCK

    anthropic_api_key: str | None = None
    anthropic_model: str | None = None

    openai_api_key: str | None = None
    openai_model: str | None = None

    azure_openai_endpoint: str | None = None
    azure_openai_api_key: str | None = None
    azure_deployment_name: str | None = None
    azure_model_name: str | None = None
    openai_api_version: str | None = None

    log_level: str = "INFO"


def configure_logging(settings: Settings | None = None) -> None:
    """Configure root logging based on the LOG_LEVEL setting.

    Args:
        settings: Settings instance to read LOG_LEVEL from. A fresh
            Settings() is loaded from the environment if not provided.
    """
    settings = settings or Settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
