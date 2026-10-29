"""Tests for src.llm.retry."""

from unittest.mock import MagicMock, call

import pytest
from src.llm.retry import RetryingLLMProvider


def _rate_limit_error() -> Exception:
    """Build an exception shaped like a real SDK's 429 rate-limit error."""
    exc = Exception("rate limited")
    exc.status_code = 429  # type: ignore[attr-defined]
    return exc


def test_retries_a_rate_limit_with_growing_delay_then_succeeds() -> None:
    """Rate limits are retried with exponential backoff, arguments unchanged."""
    provider = MagicMock()
    provider.complete.side_effect = [_rate_limit_error(), _rate_limit_error(), "ok"]
    sleep = MagicMock()
    wrapper = RetryingLLMProvider(
        provider, base_delay=2.0, exponential_factor=2.0, max_attempts=3, sleep=sleep
    )

    result = wrapper.complete(system_prompt="sys", user_prompt="user", json_mode=True)

    assert result == "ok"
    assert provider.complete.call_args_list == 3 * [
        call(system_prompt="sys", user_prompt="user", json_mode=True)
    ]
    assert [c.args[0] for c in sleep.call_args_list] == [2.0, 4.0]


def test_gives_up_on_other_errors_at_once_and_on_rate_limits_eventually() -> None:
    """Only rate limits are retried, and only until attempts run out."""
    provider = MagicMock()
    provider.complete.side_effect = ValueError("not a rate limit")
    sleep = MagicMock()
    wrapper = RetryingLLMProvider(provider, max_attempts=2, sleep=sleep)

    with pytest.raises(ValueError, match="not a rate limit"):
        wrapper.complete(system_prompt="sys", user_prompt="user")
    assert provider.complete.call_count == 1
    sleep.assert_not_called()

    provider.reset_mock()
    provider.complete.side_effect = [_rate_limit_error(), _rate_limit_error()]

    with pytest.raises(Exception, match="rate limited"):
        wrapper.complete(system_prompt="sys", user_prompt="user")
    assert provider.complete.call_count == 2
    assert sleep.call_count == 1
