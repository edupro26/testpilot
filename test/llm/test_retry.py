"""Tests for src.llm.retry."""

from unittest.mock import MagicMock

import pytest
from src.llm.retry import RetryingLLMProvider


def _rate_limit_error() -> Exception:
    """Build an exception shaped like a real SDK's 429 rate-limit error."""
    exc = Exception("rate limited")
    exc.status_code = 429  # type: ignore[attr-defined]
    return exc


def _other_error() -> Exception:
    """Build an exception with no status_code, i.e. not a rate limit."""
    return ValueError("not a rate limit")


def test_returns_result_on_first_success() -> None:
    """No retry, no sleep, when the first call succeeds."""
    provider = MagicMock()
    provider.complete.return_value = "ok"
    sleep = MagicMock()
    wrapper = RetryingLLMProvider(provider, sleep=sleep)

    result = wrapper.complete(system_prompt="sys", user_prompt="user")

    assert result == "ok"
    sleep.assert_not_called()


def test_retries_on_rate_limit_with_growing_delay_then_succeeds() -> None:
    """A rate-limit error is retried, with an exponentially growing delay."""
    provider = MagicMock()
    provider.complete.side_effect = [_rate_limit_error(), _rate_limit_error(), "ok"]
    sleep = MagicMock()
    wrapper = RetryingLLMProvider(
        provider, base_delay=2.0, exponential_factor=2.0, max_attempts=3, sleep=sleep
    )

    result = wrapper.complete(system_prompt="sys", user_prompt="user")

    assert result == "ok"
    assert provider.complete.call_count == 3
    assert [call.args[0] for call in sleep.call_args_list] == [2.0, 4.0]


def test_raises_immediately_on_non_rate_limit_error() -> None:
    """A non-rate-limit error is never retried."""
    provider = MagicMock()
    provider.complete.side_effect = _other_error()
    sleep = MagicMock()
    wrapper = RetryingLLMProvider(provider, sleep=sleep)

    with pytest.raises(ValueError, match="not a rate limit"):
        wrapper.complete(system_prompt="sys", user_prompt="user")

    assert provider.complete.call_count == 1
    sleep.assert_not_called()


def test_raises_after_exhausting_attempts() -> None:
    """A persistent rate limit is re-raised once attempts are exhausted."""
    provider = MagicMock()
    provider.complete.side_effect = [_rate_limit_error(), _rate_limit_error()]
    sleep = MagicMock()
    wrapper = RetryingLLMProvider(provider, max_attempts=2, sleep=sleep)

    with pytest.raises(Exception, match="rate limited"):
        wrapper.complete(system_prompt="sys", user_prompt="user")

    assert provider.complete.call_count == 2
    assert sleep.call_count == 1


def test_forwards_arguments_to_inner_provider() -> None:
    """system_prompt/user_prompt/json_mode are passed through unchanged."""
    provider = MagicMock()
    provider.complete.return_value = "ok"
    wrapper = RetryingLLMProvider(provider, sleep=MagicMock())

    wrapper.complete(system_prompt="sys", user_prompt="user", json_mode=True)

    provider.complete.assert_called_once_with(
        system_prompt="sys", user_prompt="user", json_mode=True
    )
