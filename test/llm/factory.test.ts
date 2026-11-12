/** Tests for src/llm/factory. */

import { expect, test } from 'vitest';

import { loadSettings } from '../../src/config.ts';
import { getLlmProvider } from '../../src/llm/factory.ts';
import { AzureOpenAIProvider } from '../../src/llm/provider/azure-openai.ts';
import { RetryingLLMProvider } from '../../src/llm/retry.ts';
import { ConfigurationError } from '../../src/runtime/exceptions.ts';

const AZURE_ENV = {
    TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    TESTPILOT_AZURE_OPENAI_API_KEY: 'fake-key',
    TESTPILOT_AZURE_DEPLOYMENT_NAME: 'fake-deployment',
    TESTPILOT_AZURE_MODEL_NAME: 'fake-model',
    TESTPILOT_OPENAI_API_VERSION: '2025-04-01-preview',
};
const NO_PROJECT = 'no-such-project';

test('builds the configured provider, wrapped in retry', () => {
    // Azure OpenAI is the default, and needs its credentials. Every provider
    // comes back wrapped in retry protection.
    const unconfigured = loadSettings({}, NO_PROJECT);
    expect(() => getLlmProvider(unconfigured)).toThrow(ConfigurationError);
    expect(() => getLlmProvider(unconfigured)).toThrow(
        /Missing required TESTPILOT_AZURE_OPENAI_ENDPOINT/,
    );

    const provider = getLlmProvider(loadSettings(AZURE_ENV, NO_PROJECT));
    expect(provider).toBeInstanceOf(RetryingLLMProvider);
    expect(provider.provider).toBeInstanceOf(AzureOpenAIProvider);
});
