"""Anthropic-backed LLM provider."""

from anthropic import Anthropic

from src.config import Settings

_MAX_TOKENS = 4096
_JSON_MODE_INSTRUCTION = (
    "\n\nRespond with ONLY valid JSON, no commentary or code fences."
)


class AnthropicProvider:
    """LLMProvider implementation backed by the Anthropic API.

    Anthropic has no dedicated JSON-response mode like OpenAI/Azure OpenAI's
    response_format. When json_mode is requested, a plain-language
    instruction is appended to the system prompt instead.
    """

    def __init__(self, settings: Settings) -> None:
        """Initialize the Anthropic client from settings.

        Args:
            settings: Application settings containing Anthropic credentials.

        Raises:
            ValueError: If required Anthropic settings are missing.
        """
        self._require_settings(
            {
                "ANTHROPIC_API_KEY": settings.anthropic_api_key,
                "ANTHROPIC_MODEL": settings.anthropic_model,
            }
        )
        self._client = Anthropic(api_key=settings.anthropic_api_key)
        self._model = settings.anthropic_model

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the model's completion for the given prompt pair."""
        system = system_prompt
        if json_mode:
            system = f"{system_prompt}{_JSON_MODE_INSTRUCTION}"

        response = self._client.messages.create(
            model=self._model,
            max_tokens=_MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": user_prompt}],
        )
        if not response.content:
            return ""
        return response.content[0].text

    @staticmethod
    def _require_settings(required: dict[str, str | None]) -> None:
        """Raise ValueError listing any of `required` that are missing.

        Args:
            required: Mapping of env var name to its resolved value.

        Raises:
            ValueError: If any value in `required` is falsy.
        """
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ValueError(
                f"Missing required Anthropic settings: {', '.join(missing)}"
            )
