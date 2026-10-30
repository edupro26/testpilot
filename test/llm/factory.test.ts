/** Tests for src/llm/factory. */

import { expect, test } from 'vitest';

import { loadSettings } from '../../src/config.ts';
import { ConfigurationError } from '../../src/exceptions.ts';
import { getLlmProvider } from '../../src/llm/factory.ts';
import { AzureOpenAIProvider } from '../../src/llm/provider/azure-openai.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';
import { RetryingLLMProvider } from '../../src/llm/retry.ts';

const AZURE_ENV = {
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    AZURE_OPENAI_API_KEY: 'fake-key',
    AZURE_DEPLOYMENT_NAME: 'fake-deployment',
    AZURE_MODEL_NAME: 'fake-model',
    OPENAI_API_VERSION: '2025-04-01-preview',
};
const NO_ENV_FILE = 'no-such.env';

test('builds the configured provider, wrapped in retry', () => {
    // Mock is the default; a real provider needs its credentials.
    // Every provider comes back wrapped in retry protection.
    let provider = getLlmProvider(loadSettings({}, NO_ENV_FILE));
    expect(provider).toBeInstanceOf(RetryingLLMProvider);
    expect(provider.provider).toBeInstanceOf(MockProvider);

    const azure = loadSettings({ LLM_PROVIDER: 'azure_openai' }, NO_ENV_FILE);
    expect(() => getLlmProvider(azure)).toThrow(ConfigurationError);
    expect(() => getLlmProvider(azure)).toThrow(
        /Missing required AZURE_OPENAI_ENDPOINT/,
    );

    provider = getLlmProvider(
        loadSettings({ LLM_PROVIDER: 'azure_openai', ...AZURE_ENV }, NO_ENV_FILE),
    );
    expect(provider).toBeInstanceOf(RetryingLLMProvider);
    expect(provider.provider).toBeInstanceOf(AzureOpenAIProvider);
});
