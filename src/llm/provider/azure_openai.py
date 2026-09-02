"""Azure OpenAI-backed LLM provider."""

import logging
from typing import Any

from openai import AzureOpenAI

from src.config import Settings
from src.exceptions import ConfigurationError

logger = logging.getLogger(__name__)


class AzureOpenAIProvider:
    """LLMProvider implementation backed by Azure OpenAI."""

    def __init__(self, settings: Settings) -> None:
        """Initialize the Azure OpenAI client from settings.

        Args:
            settings: Application settings containing Azure OpenAI credentials.

        Raises:
            ConfigurationError: If required Azure OpenAI settings are missing.
        """
        self._require_settings(
            {
                "AZURE_OPENAI_ENDPOINT": settings.azure_openai_endpoint,
                "AZURE_OPENAI_API_KEY": settings.azure_openai_api_key,
                "AZURE_DEPLOYMENT_NAME": settings.azure_deployment_name,
                "OPENAI_API_VERSION": settings.openai_api_version,
            }
        )
        self._client = AzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key,
            api_version=settings.openai_api_version,
        )
        self._deployment = settings.azure_deployment_name
        logger.debug(
            "Azure OpenAI client configured (endpoint=%s, deployment=%s, "
            "api_version=%s)",
            settings.azure_openai_endpoint,
            self._deployment,
            settings.openai_api_version,
        )

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the model's completion for the given prompt pair."""
        logger.info(
            "Requesting completion from Azure OpenAI (deployment=%s, json_mode=%s)",
            self._deployment,
            json_mode,
        )
        kwargs: dict[str, Any] = {
            "model": self._deployment,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        response = self._client.chat.completions.create(**kwargs)
        return response.choices[0].message.content or ""

    @staticmethod
    def _require_settings(required: dict[str, str | None]) -> None:
        """Raise ConfigurationError listing any of `required` that are missing.

        Args:
            required: Mapping of env var name to its resolved value.

        Raises:
            ConfigurationError: If any value in `required` is falsy.
        """
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ConfigurationError(f"Missing required {', '.join(missing)}")
