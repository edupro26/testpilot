"""Retry wrapper: shields any LLMProvider from transient rate-limit errors."""

import logging
import time
from collections.abc import Callable
from typing import TypeVar

from src.llm.protocol import Conversation, LLMProvider, ToolResult, ToolUseResponse

logger = logging.getLogger(__name__)

_BASE_DELAY_SECONDS = 2.0
_MAX_ATTEMPTS = 3
_EXPONENTIAL_FACTOR = 2.0


T = TypeVar("T")


def _is_rate_limit(exc: Exception) -> bool:
    """Whether `exc` looks like an HTTP 429 from any provider SDK."""
    return getattr(exc, "status_code", None) == 429


class RetryingLLMProvider:
    """Wraps an LLMProvider, retrying `complete()` and conversation turns.

    Only rate-limit errors are retried; anything else is re-raised at once.
    """

    def __init__(
        self,
        provider: LLMProvider,
        *,
        base_delay: float = _BASE_DELAY_SECONDS,
        max_attempts: int = _MAX_ATTEMPTS,
        exponential_factor: float = _EXPONENTIAL_FACTOR,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """Initialize the wrapper around `provider`.

        Args:
            provider: The LLMProvider implementation to protect.
            base_delay: Seconds to wait before the first retry.
            max_attempts: Total attempts, including the first.
            exponential_factor: Delay multiplier applied after each retry.
            sleep: Sleep function to call between retries (injectable for tests).
        """
        self.provider = provider
        self._base_delay = base_delay
        self._max_attempts = max_attempts
        self._exponential_factor = exponential_factor
        self._sleep = sleep

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Delegate to `provider.complete`, retrying on rate-limit errors.

        Args:
            system_prompt: Instructions framing the model's role/behavior.
            user_prompt: The rendered, stage-specific prompt content.
            json_mode: Whether to request a JSON-only response.

        Returns:
            The completion text from `provider`.

        Raises:
            Exception: Whatever `provider.complete` raises, after retries are
                exhausted or immediately for a non-rate-limit error.
        """
        return self._with_retry(
            lambda: self.provider.complete(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                json_mode=json_mode,
            )
        )

    def start_conversation(
        self, *, system_prompt: str, user_prompt: str, tools: list[dict]
    ) -> "RetryingConversation":
        """Start a conversation whose every turn is retry-protected.

        Args:
            system_prompt: Instructions framing the model's role/behavior.
            user_prompt: The opening user turn.
            tools: Tool definitions in the neutral MCP shape.

        Returns:
            The provider's conversation, wrapped for retries.
        """
        conversation = self.provider.start_conversation(
            system_prompt=system_prompt, user_prompt=user_prompt, tools=tools
        )
        return RetryingConversation(conversation, self._with_retry)

    def _with_retry(self, call: Callable[[], T]) -> T:
        """Run `call`, retrying with exponential backoff on rate limits.

        Args:
            call: The provider operation to attempt.

        Returns:
            Whatever `call` returns.

        Raises:
            Exception: Whatever `call` raises, after retries are exhausted
                or immediately for a non-rate-limit error.
        """
        delay = self._base_delay
        attempt = 1
        while True:
            try:
                return call()
            except Exception as exc:
                if not _is_rate_limit(exc) or attempt >= self._max_attempts:
                    raise
                logger.warning(
                    "Rate limited (attempt %d/%d), retrying in %.0fs",
                    attempt,
                    self._max_attempts,
                    delay,
                )
                self._sleep(delay)
                delay *= self._exponential_factor
                attempt += 1


class RetryingConversation:
    """Wraps a Conversation so each turn inherits rate-limit retries."""

    def __init__(
        self,
        conversation: Conversation,
        with_retry: Callable[[Callable[[], ToolUseResponse]], ToolUseResponse],
    ) -> None:
        """Initialize the wrapper.

        Args:
            conversation: The provider conversation to protect.
            with_retry: The owning provider's retry helper.
        """
        self.conversation = conversation
        self._with_retry = with_retry

    def send(self, results: list[ToolResult] | None = None) -> ToolUseResponse:
        """Delegate to `conversation.send`, retrying on rate-limit errors."""
        return self._with_retry(lambda: self.conversation.send(results))
