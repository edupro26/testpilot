"""Application settings and logging configuration."""

import logging
import os
from enum import StrEnum

from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class LLMProviderName(StrEnum):
    """Supported values for the LLM_PROVIDER setting."""

    MOCK = "mock"
    AZURE_OPENAI = "azure_openai"


class Settings(BaseSettings):
    """Typed application settings loaded from the environment or .env file."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    llm_provider: LLMProviderName = LLMProviderName.MOCK

    azure_openai_endpoint: str | None = None
    azure_openai_api_key: str | None = None
    azure_deployment_name: str | None = None
    azure_model_name: str | None = None
    openai_api_version: str | None = None

    # Shared by the MCP browser, the validation browser and the generated script,
    # since sites localise by Accept-Language.
    browser_locale: str = "en-US"

    mcp_url: str = "http://localhost:8931/mcp"
    mcp_max_turns: int = 25

    log_level: str = "INFO"


_LEVEL_COLORS = {
    logging.DEBUG: "\033[36m",  # cyan
    logging.INFO: "\033[32m",  # green
    logging.WARNING: "\033[33m",  # yellow
    logging.ERROR: "\033[31m",  # red
    logging.CRITICAL: "\033[1;31m",  # bold red
}
_COLOR_RESET = "\033[0m"
_NOISY_LOGGERS = ("httpx", "httpcore", "httpcore2", "openai")
_FMT = "[%(asctime)s] [%(levelname)s] %(message)s"


class _LogFormatter(logging.Formatter):
    """Formatter that colors the level name according to its severity."""

    def __init__(self, datefmt: str) -> None:
        """Initialize the formatter with `datefmt`."""
        super().__init__(fmt=_FMT, datefmt=datefmt)

    def format(self, record: logging.LogRecord) -> str:
        """Format `record`, wrapping its level name in an ANSI color code."""
        color = _LEVEL_COLORS.get(record.levelno)
        if color is None:
            return super().format(record)

        original_levelname = record.levelname
        record.levelname = f"{color}{original_levelname}{_COLOR_RESET}"
        try:
            return super().format(record)
        finally:
            record.levelname = original_levelname


def configure_logging(settings: Settings | None = None) -> None:
    """Configure root logging based on the LOG_LEVEL setting.

    Args:
        settings: Settings instance to read LOG_LEVEL from. A fresh
            Settings() is loaded from the environment if not provided. If
            that fails (e.g. an unsupported LLM_PROVIDER), LOG_LEVEL is read
            directly from the environment so the failure can still be
            logged at the level the caller actually asked for.
    """
    if settings is None:
        try:
            settings = Settings()
        except ValidationError:
            settings = None
    level = settings.log_level if settings else os.environ.get("LOG_LEVEL", "INFO")

    handler = logging.StreamHandler()
    handler.setFormatter(_LogFormatter(datefmt="%H:%M:%S"))
    logging.basicConfig(level=level, handlers=[handler])

    for noisy_logger in _NOISY_LOGGERS:
        logging.getLogger(noisy_logger).setLevel(logging.WARNING)
