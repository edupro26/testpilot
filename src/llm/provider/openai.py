"""OpenAI-backed LLM provider."""

import logging
from typing import Any

from openai import OpenAI

from src.config import Settings
from src.exceptions import ConfigurationError

logger = logging.getLogger(__name__)


class OpenAIProvider:
    """LLMProvider implementation backed by the OpenAI API."""

    def __init__(self, settings: Settings) -> None:
        """Initialize the OpenAI client from settings.

        Args:
            settings: Application settings containing OpenAI credentials.

        Raises:
            ConfigurationError: If required OpenAI settings are missing.
        """
        self._require_settings(
            {
                "OPENAI_API_KEY": settings.openai_api_key,
                "OPENAI_MODEL": settings.openai_model,
            }
        )
        self._client = OpenAI(api_key=settings.openai_api_key)
        self._model = settings.openai_model

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the model's completion for the given prompt pair."""
        logger.info(
            "Requesting completion from OpenAI (model=%s, json_mode=%s)",
            self._model,
            json_mode,
        )
        kwargs: dict[str, Any] = {
            "model": self._model,
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
