/** Tests for the LLMProvider implementations. */

import { beforeEach, expect, type Mock, test, vi } from 'vitest';

import { loadSettings } from '../../src/config.ts';
import { AzureOpenAIProvider } from '../../src/llm/provider/azure-openai.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';

const azure = vi.hoisted<{ options: unknown; create: Mock }>(() => ({
    options: undefined,
    create: vi.fn(),
}));

vi.mock('openai', () => ({
    AzureOpenAI: class {
        chat = { completions: { create: azure.create } };

        constructor(options: unknown) {
            azure.options = options;
        }
    },
}));

const NO_PROJECT = 'no-such-project';

const AZURE_ENV = {
    TESTPILOT_LLM_PROVIDER: 'azure_openai',
    TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    TESTPILOT_AZURE_OPENAI_API_KEY: 'fake-key',
    TESTPILOT_AZURE_DEPLOYMENT_NAME: 'fake-deployment',
    TESTPILOT_AZURE_MODEL_NAME: 'fake-model',
    TESTPILOT_OPENAI_API_VERSION: '2025-04-01-preview',
};

/** A Chat Completions response carrying one assistant message. */
function reply(message: Record<string, unknown>): unknown {
    return { choices: [{ message: { role: 'assistant', content: null, ...message } }] };
}

beforeEach(() => {
    azure.create.mockReset();
});

test('Azure complete sends the request and returns the text', async () => {
    // The deployment is pinned in the client, so `model` carries the name.
    // jsonMode toggles a JSON-only response, and missing content is normalized
    // to an empty string.
    const provider = new AzureOpenAIProvider(loadSettings(AZURE_ENV, NO_PROJECT));
    expect(azure.options).toMatchObject({ deployment: 'fake-deployment' });

    azure.create.mockResolvedValue(reply({ content: 'hello' }));
    expect(await provider.complete({ systemPrompt: 'sys', userPrompt: 'user' })).toBe(
        'hello',
    );
    let request = azure.create.mock.lastCall?.[0] as Record<string, unknown>;
    expect(request.model).toBe('fake-model');
    expect(request).not.toHaveProperty('response_format');

    azure.create.mockResolvedValue(reply({ content: null }));
    expect(
        await provider.complete({ systemPrompt: 's', userPrompt: 'u', jsonMode: true }),
    ).toBe('');
    request = azure.create.mock.lastCall?.[0] as Record<string, unknown>;
    expect(request.response_format).toEqual({ type: 'json_object' });
});

test('Azure conversation translates tools and threads tool results', async () => {
    // Tools go out in the function shape; calls come back parsed, and their
    // results are sent on the next turn under the call's id.
    const provider = new AzureOpenAIProvider(loadSettings(AZURE_ENV, NO_PROJECT));
    const conversation = provider.startConversation({
        systemPrompt: 'sys',
        userPrompt: 'user',
        tools: [
            {
                name: 'browser_click',
                description: 'Click',
                inputSchema: { type: 'object' },
            },
        ],
    });
    const call = {
        id: 'call-1',
        type: 'function',
        function: { name: 'browser_click', arguments: '{"target": "e1"}' },
    };
    azure.create
        .mockResolvedValueOnce(reply({ tool_calls: [call] }))
        .mockResolvedValueOnce(reply({ content: 'done' }));

    const first = await conversation.send();
    const second = await conversation.send([{ id: 'call-1', content: 'clicked' }]);

    expect(first.toolCalls).toEqual([
        { id: 'call-1', name: 'browser_click', arguments: { target: 'e1' } },
    ]);
    expect(second).toEqual({ text: 'done', toolCalls: [] });
    const opening = azure.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opening.tools).toEqual([
        {
            type: 'function',
            function: {
                name: 'browser_click',
                description: 'Click',
                parameters: { type: 'object' },
            },
        },
    ]);
    const followUp = azure.create.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(followUp.messages.slice(2)).toEqual([
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: 'call-1', content: 'clicked' },
    ]);
});

test('Azure conversation records a turn only once its request succeeds', async () => {
    // A failed turn is retried with the same results; they must be sent once.
    const provider = new AzureOpenAIProvider(loadSettings(AZURE_ENV, NO_PROJECT));
    const conversation = provider.startConversation({
        systemPrompt: 'sys',
        userPrompt: 'user',
        tools: [],
    });
    const call = {
        id: 'call-1',
        type: 'function',
        function: { name: 'browser_click', arguments: '{}' },
    };
    azure.create
        .mockResolvedValueOnce(reply({ tool_calls: [call] }))
        .mockRejectedValueOnce(
            Object.assign(new Error('rate limited'), { status: 429 }),
        )
        .mockResolvedValueOnce(reply({ content: 'done' }));
    const results = [{ id: 'call-1', content: 'clicked' }];

    await conversation.send();
    await expect(conversation.send(results)).rejects.toThrow('rate limited');
    await conversation.send(results);

    const retried = azure.create.mock.calls[2]?.[0] as { messages: unknown[] };
    expect(retried.messages.slice(2)).toEqual([
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: 'call-1', content: 'clicked' },
    ]);
});

test('mock provider returns fixed or computed responses', async () => {
    // A string is returned as-is, a function gets both prompts, default is ''.
    const fixed = new MockProvider('canned response');
    const computed = new MockProvider((system, user) => `${system}:${user}`);
    const request = { systemPrompt: 'sys', userPrompt: 'user' };

    expect(await fixed.complete(request)).toBe('canned response');
    expect(await computed.complete(request)).toBe('sys:user');
    expect(await new MockProvider().complete(request)).toBe('');
});
