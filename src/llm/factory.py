"""LLM provider selection."""

from src.config import LLMProviderName, Settings
from src.exceptions import ConfigurationError
from src.llm.protocol import LLMProvider
from src.llm.provider.anthropic import AnthropicProvider
from src.llm.provider.azure_openai import AzureOpenAIProvider
from src.llm.provider.mock import MockProvider
from src.llm.provider.openai import OpenAIProvider


def get_llm_provider(settings: Settings) -> LLMProvider:
    """Return the configured LLMProvider implementation.

    Args:
        settings: Application settings, including llm_provider.

    Returns:
        The selected LLMProvider implementation.

    Raises:
        ConfigurationError: If llm_provider does not name one of the
            supported providers, or the selected provider is missing
            required settings.
    """
    match settings.llm_provider:
        case LLMProviderName.MOCK:
            return MockProvider()
        case LLMProviderName.AZURE_OPENAI:
            return AzureOpenAIProvider(settings)
        case LLMProviderName.OPENAI:
            return OpenAIProvider(settings)
        case LLMProviderName.ANTHROPIC:
            return AnthropicProvider(settings)
        case _:
            raise ConfigurationError(f"{settings.llm_provider} is not supported")
