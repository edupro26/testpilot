/** Tests for the Azure OpenAI provider against the real SDK client. */

import { afterEach, expect, test, vi } from 'vitest';

import { loadSettings } from '../../src/config.ts';
import { AzureOpenAIProvider } from '../../src/llm/provider/azure-openai.ts';

const AZURE_ENV = {
    TESTPILOT_LLM_PROVIDER: 'azure_openai',
    TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    TESTPILOT_AZURE_OPENAI_API_KEY: 'fake-key',
    TESTPILOT_AZURE_DEPLOYMENT_NAME: 'fake-deployment',
    TESTPILOT_AZURE_MODEL_NAME: 'fake-model',
    TESTPILOT_OPENAI_API_VERSION: '2025-04-01-preview',
};

afterEach(() => {
    vi.unstubAllEnvs();
});

test('an OPENAI_BASE_URL in the environment does not override the endpoint', () => {
    // The SDK reads it by default, and refuses it alongside an endpoint.
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example.com/v1');

    expect(
        () => new AzureOpenAIProvider(loadSettings(AZURE_ENV, 'no-such-project')),
    ).not.toThrow();
});
