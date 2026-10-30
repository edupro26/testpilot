/** LLM provider selection. */

import type { Settings } from '../config.ts';
import { ConfigurationError } from '../exceptions.ts';
import type { LLMProvider } from './protocol.ts';
import { AzureOpenAIProvider } from './provider/azure-openai.ts';
import { MockProvider } from './provider/mock.ts';
import { RetryingLLMProvider } from './retry.ts';

/**
 * Return the configured LLMProvider implementation.
 *
 * Always wrapped in `RetryingLLMProvider`, so every caller gets rate-limit
 * retry protection regardless of which stage calls it.
 *
 * @param settings - Application settings, including llmProvider.
 * @returns The selected provider, wrapped with retry protection.
 * @throws {ConfigurationError} If llmProvider names an unsupported provider,
 *   or the selected provider is missing required settings.
 */
export function getLlmProvider(settings: Settings): RetryingLLMProvider {
    let provider: LLMProvider;
    switch (settings.llmProvider) {
        case 'mock':
            provider = new MockProvider();
            break;
        case 'azure_openai':
            provider = new AzureOpenAIProvider(settings);
            break;
        default:
            throw new ConfigurationError(
                `${String(settings.llmProvider)} is not supported`,
            );
    }
    return new RetryingLLMProvider(provider);
}
