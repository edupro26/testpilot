"""Deterministic, offline stand-in for a real LLM provider."""

from collections.abc import Callable


class MockProvider:
    """Returns a fixed or computed response, with no network calls."""

    def __init__(self, response: str | Callable[[str, str], str] = "") -> None:
        """Initialize with a fixed response or a function computing one.

        Args:
            response: A fixed string always returned, or a callable taking
                (system_prompt, user_prompt) and returning the response text.
        """
        self._response = response

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the configured canned response."""
        _ = json_mode
        if callable(self._response):
            return self._response(system_prompt, user_prompt)
        return self._response
