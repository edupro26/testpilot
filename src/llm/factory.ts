/** LLM provider selection. */

import type { LLMProviderName, Settings } from '../config.ts';
import type { LLMProvider } from './protocol.ts';
import { AzureOpenAIProvider } from './provider/azure-openai.ts';
import { RetryingLLMProvider } from './retry.ts';

/** How to build each provider a run can select. */
const PROVIDERS: Record<LLMProviderName, new (settings: Settings) => LLMProvider> = {
    azure_openai: AzureOpenAIProvider,
};

/**
 * Return the configured LLMProvider implementation.
 *
 * Always wrapped in `RetryingLLMProvider`, so every caller gets rate-limit
 * retry protection regardless of which stage calls it.
 *
 * @param settings - Application settings, including llmProvider.
 * @returns The selected provider, wrapped with retry protection.
 * @throws {ConfigurationError} If the selected provider is missing required
 *   settings.
 */
export function getLlmProvider(settings: Settings): RetryingLLMProvider {
    const Provider = PROVIDERS[settings.llmProvider];
    return new RetryingLLMProvider(new Provider(settings));
}
