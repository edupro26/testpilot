"""LLM provider selection."""

from src.config import LLMProviderName, Settings
from src.exceptions import ConfigurationError
from src.llm.protocol import LLMProvider
from src.llm.provider.anthropic import AnthropicProvider
from src.llm.provider.azure_openai import AzureOpenAIProvider
from src.llm.provider.mock import MockProvider
from src.llm.provider.openai import OpenAIProvider
from src.llm.retry import RetryingLLMProvider


def get_llm_provider(settings: Settings) -> LLMProvider:
    """Return the configured LLMProvider implementation.

    Always wrapped in `RetryingLLMProvider`, so every caller gets
    rate-limit retry protection regardless of which stage calls it.

    Args:
        settings: Application settings, including llm_provider.

    Returns:
        The selected provider, wrapped with retry protection.

    Raises:
        ConfigurationError: If llm_provider names an unsupported provider,
            or the selected provider is missing required settings.
    """
    match settings.llm_provider:
        case LLMProviderName.MOCK:
            provider = MockProvider()
        case LLMProviderName.AZURE_OPENAI:
            provider = AzureOpenAIProvider(settings)
        case LLMProviderName.OPENAI:
            provider = OpenAIProvider(settings)
        case LLMProviderName.ANTHROPIC:
            provider = AnthropicProvider(settings)
        case _:
            raise ConfigurationError(f"{settings.llm_provider} is not supported")
    return RetryingLLMProvider(provider)
