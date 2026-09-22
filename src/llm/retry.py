"""Retry wrapper: shields any LLMProvider from transient rate-limit errors."""

import logging
import time
from collections.abc import Callable

from src.llm.protocol import LLMProvider

logger = logging.getLogger(__name__)

_BASE_DELAY_SECONDS = 2.0
_MAX_ATTEMPTS = 3
_EXPONENTIAL_FACTOR = 2.0


class RetryingLLMProvider:
    """Wraps an LLMProvider, retrying `complete()` on rate-limit errors.

    Every other exception is re-raised immediately, unretried.
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
        delay = self._base_delay
        attempt = 1
        while True:
            try:
                return self.provider.complete(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    json_mode=json_mode,
                )
            except Exception as exc:
                is_rate_limit = getattr(exc, "status_code", None) == 429
                if not is_rate_limit or attempt >= self._max_attempts:
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
