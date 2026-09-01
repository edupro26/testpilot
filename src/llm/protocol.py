"""LLM provider interface."""

from typing import Protocol


class LLMProvider(Protocol):
    """Interface every LLM provider implementation must satisfy."""

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the raw text completion for the given prompt pair.

        Args:
            system_prompt: Instructions framing the model's role/behavior.
            user_prompt: The rendered, stage-specific prompt content.
            json_mode: Whether to request a JSON-only response, if the
                provider supports it.

        Returns:
            The completion text.
        """
        ...
