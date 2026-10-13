"""Azure OpenAI-backed LLM provider."""

import logging
from typing import Any

from openai import AzureOpenAI

from src.config import Settings
from src.exceptions import ConfigurationError
from src.llm.provider.openai_chat import OpenAIChatConversation

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
                "AZURE_MODEL_NAME": settings.azure_model_name,
                "OPENAI_API_VERSION": settings.openai_api_version,
            }
        )
        self._client = AzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            azure_deployment=settings.azure_deployment_name,
            api_key=settings.azure_openai_api_key,
            api_version=settings.openai_api_version,
        )
        self._model = settings.azure_model_name
        logger.debug(
            "Azure OpenAI client configured (endpoint=%s, model=%s, api_version=%s)",
            settings.azure_openai_endpoint,
            settings.azure_model_name,
            settings.openai_api_version,
        )

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the model's completion for the given prompt pair."""
        logger.info(
            "Requesting completion from Azure OpenAI (model=%s, json_mode=%s)",
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

    def start_conversation(
        self, *, system_prompt: str, user_prompt: str, tools: list[dict]
    ) -> OpenAIChatConversation:
        """Open a tool-calling conversation against Azure OpenAI."""
        logger.info(
            "Starting Azure OpenAI tool conversation (model=%s, %d tool(s))",
            self._model,
            len(tools),
        )
        return OpenAIChatConversation(
            self._client,
            self._model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            tools=tools,
        )

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
