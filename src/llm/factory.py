"""LLM provider selection."""

from src.config import LLMProviderName, Settings
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
        ValueError: If llm_provider does not name one of the supported
            providers.
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
            raise ValueError(f"{settings.llm_provider} is not supported")
