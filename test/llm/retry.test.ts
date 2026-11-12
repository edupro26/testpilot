/** Tests for src/llm/retry. */

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
