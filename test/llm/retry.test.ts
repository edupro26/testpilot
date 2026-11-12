/** Tests for src/llm/retry. */

import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { expect, test, vi } from 'vitest';

import type { CompletionRequest, LLMProvider } from '../../src/llm/protocol.ts';
import { RetryingLLMProvider } from '../../src/llm/retry.ts';

/** Build an error shaped like a real SDK's 429 rate-limit error. */
function rateLimitError(): Error {
    return Object.assign(new Error('rate limited'), { status: 429 });
}

function provider(complete: LLMProvider['complete']): LLMProvider {
    return {
        complete,
        startConversation: () => {
            throw new Error('not used');
        },
    };
}

test('retries a rate limit with growing delay, then succeeds', async () => {
    // Rate limits are retried with exponential backoff, arguments unchanged.
    const complete = vi
        .fn<(request: CompletionRequest) => Promise<string>>()
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(rateLimitError())
        .mockResolvedValue('ok');
    const sleep = vi
        .fn<(seconds: number) => Promise<void>>()
        .mockResolvedValue(undefined);
    const wrapper = new RetryingLLMProvider(provider(complete), {
        baseDelay: 2.0,
        exponentialFactor: 2.0,
        maxAttempts: 3,
        sleep,
    });
    const request = { systemPrompt: 'sys', userPrompt: 'user', jsonMode: true };

    const result = await wrapper.complete(request);

    expect(result).toBe('ok');
    expect(complete.mock.calls).toEqual([[request], [request], [request]]);
    expect(sleep.mock.calls.map(([seconds]) => seconds)).toEqual([2.0, 4.0]);
});

test('gives up on other errors at once, and on rate limits eventually', async () => {
    // Only rate limits are retried, and only until attempts run out.
    const complete = vi
        .fn<(request: CompletionRequest) => Promise<string>>()
        .mockRejectedValue(new Error('not a rate limit'));
    const sleep = vi
        .fn<(seconds: number) => Promise<void>>()
        .mockResolvedValue(undefined);
    const wrapper = new RetryingLLMProvider(provider(complete), {
        maxAttempts: 2,
        sleep,
    });
    const request = { systemPrompt: 'sys', userPrompt: 'user' };

    await expect(wrapper.complete(request)).rejects.toThrow('not a rate limit');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    complete.mockReset();
    complete
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(rateLimitError());

    await expect(wrapper.complete(request)).rejects.toThrow('rate limited');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
});

test("waits as long as the rate limit's Retry-After asks, when that is longer", async () => {
    // Azure says when its quota frees up; retrying sooner only fails again.
    const limited = (retryAfter: string): Error =>
        Object.assign(new Error('rate limited'), {
            status: 429,
            headers: new Headers({ 'retry-after': retryAfter }),
        });
    const complete = vi
        .fn<(request: CompletionRequest) => Promise<string>>()
        .mockRejectedValueOnce(limited('20'))
        .mockRejectedValueOnce(limited('1'))
        .mockResolvedValue('ok');
    const sleep = vi
        .fn<(seconds: number) => Promise<void>>()
        .mockResolvedValue(undefined);
    const wrapper = new RetryingLLMProvider(provider(complete), { sleep });

    expect(await wrapper.complete({ systemPrompt: 's', userPrompt: 'u' })).toBe('ok');
    expect(sleep.mock.calls.map(([seconds]) => seconds)).toEqual([20, 4]);
});

test.each([
    [
        'a server error',
        Object.assign(new Error('500 Internal server error'), { status: 500 }),
    ],
    [
        'an overloaded service',
        Object.assign(new Error('503 Service Unavailable'), { status: 503 }),
    ],
    ['a request timeout status', Object.assign(new Error('408'), { status: 408 })],
    ['a conflict', Object.assign(new Error('409'), { status: 409 })],
    ['a dropped connection', new APIConnectionError({ message: 'socket hang up' })],
])(
    'retries %s, as the SDK did before its retries were turned off',
    async (_name, error) => {
        // One transient failure among a run's many LLM calls must not fail the run.
        const complete = vi
            .fn<(request: CompletionRequest) => Promise<string>>()
            .mockRejectedValueOnce(error)
            .mockResolvedValue('ok');
        const sleep = vi
            .fn<(seconds: number) => Promise<void>>()
            .mockResolvedValue(undefined);
        const wrapper = new RetryingLLMProvider(provider(complete), { sleep });

        expect(await wrapper.complete({ systemPrompt: 's', userPrompt: 'u' })).toBe(
            'ok',
        );
        expect(complete).toHaveBeenCalledTimes(2);
    },
);

test.each([
    ['a bad request', Object.assign(new Error('400'), { status: 400 })],
    ['a refused key', Object.assign(new Error('401'), { status: 401 })],
    ['a request that timed out', new APIConnectionTimeoutError()],
])('does not retry %s', async (_name, error) => {
    // A request that cannot succeed, or already took the whole timeout, fails
    // at once rather than tripling the wait.
    const complete = vi
        .fn<(request: CompletionRequest) => Promise<string>>()
        .mockRejectedValue(error);
    const wrapper = new RetryingLLMProvider(provider(complete), {
        sleep: () => Promise.resolve(),
    });

    await expect(wrapper.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toBe(
        error,
    );
    expect(complete).toHaveBeenCalledTimes(1);
});
