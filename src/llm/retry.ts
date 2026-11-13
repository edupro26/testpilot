/** Retry wrapper: shields any LLMProvider from transient errors. */

import { setTimeout as delay } from 'node:timers/promises';

import { APIConnectionError, APIConnectionTimeoutError } from 'openai';

import { logger } from '../logger.ts';
import { errorMessage } from '../runtime/exceptions.ts';
import type {
    CompletionRequest,
    Conversation,
    ConversationRequest,
    LLMProvider,
    ToolResult,
    ToolUseResponse,
} from './protocol.ts';

const BASE_DELAY_SECONDS = 2.0;
const MAX_ATTEMPTS = 3;
const EXPONENTIAL_FACTOR = 2.0;

type Retry = <T>(call: () => Promise<T>) => Promise<T>;

// The longest a rate limit's Retry-After is honoured for, in seconds.
const MAX_RETRY_AFTER_SECONDS = 60;

/** Whether `error` looks like an HTTP 429 from any provider SDK. */
function isRateLimit(error: unknown): boolean {
    return (error as { status?: unknown } | null)?.status === 429;
}

/**
 * Whether `error` may not happen again: a rate limit, a 408, 409 or 5xx status,
 * or a connection dropped before a response, as the OpenAI SDK's own retries
 * judged it. A request that timed out is not retried: it already took the
 * whole timeout, and another try would most likely take it again.
 */
function isTransient(error: unknown): boolean {
    if (error instanceof APIConnectionError) {
        return !(error instanceof APIConnectionTimeoutError);
    }
    const status = (error as { status?: unknown } | null)?.status;
    return (
        typeof status === 'number' &&
        (status === 408 || status === 409 || status === 429 || status >= 500)
    );
}

/**
 * How long a rate-limit error asks to wait, in seconds, from its response's
 * `retry-after-ms` or `retry-after` header; `0` when it does not say.
 */
function retryAfter(error: unknown): number {
    const headers = (error as { headers?: unknown } | null)?.headers;
    if (!(headers instanceof Headers)) {
        return 0;
    }
    const ms = Number(headers.get('retry-after-ms'));
    const seconds = ms > 0 ? ms / 1000 : Number(headers.get('retry-after'));
    return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : 0;
}

/** Options for `RetryingLLMProvider`. */
export interface RetryOptions {
    /** Seconds to wait before the first retry. */
    baseDelay?: number;
    /** Total attempts, including the first. */
    maxAttempts?: number;
    /** Delay multiplier applied after each retry. */
    exponentialFactor?: number;
    /** Sleeps between retries, in seconds (injectable for tests). */
    sleep?: (seconds: number) => Promise<void>;
}

/**
 * Wraps an LLMProvider, retrying `complete()` and conversation turns.
 *
 * Only transient errors (see `isTransient`) are retried; anything else is
 * re-raised at once. A retry waits out the backoff, or a rate limit's
 * Retry-After if longer.
 */
export class RetryingLLMProvider implements LLMProvider {
    readonly provider: LLMProvider;
    private readonly baseDelay: number;
    private readonly maxAttempts: number;
    private readonly exponentialFactor: number;
    private readonly sleep: (seconds: number) => Promise<void>;

    /**
     * Initialize the wrapper around `provider`.
     *
     * @param provider - The LLMProvider implementation to protect.
     * @param options - Backoff tuning; defaults to 2s, 3 attempts, doubling.
     */
    constructor(provider: LLMProvider, options: RetryOptions = {}) {
        this.provider = provider;
        this.baseDelay = options.baseDelay ?? BASE_DELAY_SECONDS;
        this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
        this.exponentialFactor = options.exponentialFactor ?? EXPONENTIAL_FACTOR;
        this.sleep = options.sleep ?? ((seconds) => delay(seconds * 1000));
    }

    /**
     * Delegate to `provider.complete`, retrying on transient errors.
     *
     * @param request - The completion request, passed through unchanged.
     * @returns The completion text from `provider`.
     * @throws {Error} Whatever `provider.complete` throws, after retries are exhausted
     *   or immediately for an error that is not transient.
     */
    complete(request: CompletionRequest): Promise<string> {
        return this.withRetry(() => this.provider.complete(request));
    }

    /**
     * Start a conversation whose every turn is retry-protected.
     *
     * @param request - The opening prompts and tools, passed through unchanged.
     * @returns The provider's conversation, wrapped for retries.
     */
    startConversation(request: ConversationRequest): RetryingConversation {
        const conversation = this.provider.startConversation(request);
        return new RetryingConversation(conversation, (call) => this.withRetry(call));
    }

    /**
     * Run `call`, retrying with exponential backoff on transient errors.
     *
     * @throws {Error} Whatever `call` throws, after retries are exhausted or
     *   immediately for an error that is not transient.
     */
    private async withRetry<T>(call: () => Promise<T>): Promise<T> {
        let wait = this.baseDelay;
        let attempt = 1;
        for (;;) {
            try {
                return await call();
            } catch (error) {
                if (!isTransient(error) || attempt >= this.maxAttempts) {
                    throw error;
                }
                const seconds = Math.max(wait, retryAfter(error));
                const reason = isRateLimit(error)
                    ? 'Rate limited'
                    : `LLM request failed (${errorMessage(error)})`;
                logger.warning(
                    `${reason} (attempt ${attempt}/${this.maxAttempts}), ` +
                        `retrying in ${seconds.toFixed(0)}s`,
                );
                await this.sleep(seconds);
                wait *= this.exponentialFactor;
                attempt += 1;
            }
        }
    }
}

/** Wraps a Conversation so each turn inherits the retries. */
export class RetryingConversation implements Conversation {
    readonly conversation: Conversation;
    private readonly retry: Retry;

    /**
     * Initialize the wrapper.
     *
     * @param conversation - The provider conversation to protect.
     * @param retry - The owning provider's retry helper.
     */
    constructor(conversation: Conversation, retry: Retry) {
        this.conversation = conversation;
        this.retry = retry;
    }

    /**
     * Delegate to `conversation.send`, retrying on transient errors.
     *
     * @param results - The tool results, passed through unchanged.
     * @returns The wrapped conversation's next turn.
     * @throws {Error} Whatever `conversation.send` throws, after retries are
     *   exhausted or immediately for an error that is not transient.
     */
    send(results?: ToolResult[]): Promise<ToolUseResponse> {
        return this.retry(() => this.conversation.send(results));
    }
}
