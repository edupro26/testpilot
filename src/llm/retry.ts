/** Retry wrapper: shields any LLMProvider from transient rate-limit errors. */

import { setTimeout as delay } from 'node:timers/promises';

import { logger } from '../logger.ts';
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
 * Only rate-limit errors are retried; anything else is re-raised at once. A
 * retry waits out the backoff, or the Retry-After the error carries if longer.
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
     * Delegate to `provider.complete`, retrying on rate-limit errors.
     *
     * @returns The completion text from `provider`.
     * @throws {Error} Whatever `provider.complete` throws, after retries are exhausted
     *   or immediately for a non-rate-limit error.
     */
    complete(request: CompletionRequest): Promise<string> {
        return this.withRetry(() => this.provider.complete(request));
    }

    /**
     * Start a conversation whose every turn is retry-protected.
     *
     * @returns The provider's conversation, wrapped for retries.
     */
    startConversation(request: ConversationRequest): RetryingConversation {
        const conversation = this.provider.startConversation(request);
        return new RetryingConversation(conversation, (call) => this.withRetry(call));
    }

    /**
     * Run `call`, retrying with exponential backoff on rate limits.
     *
     * @throws {Error} Whatever `call` throws, after retries are exhausted or
     *   immediately for a non-rate-limit error.
     */
    private async withRetry<T>(call: () => Promise<T>): Promise<T> {
        let wait = this.baseDelay;
        let attempt = 1;
        for (;;) {
            try {
                return await call();
            } catch (error) {
                if (!isRateLimit(error) || attempt >= this.maxAttempts) {
                    throw error;
                }
                const seconds = Math.max(wait, retryAfter(error));
                logger.warning(
                    `Rate limited (attempt ${attempt}/${this.maxAttempts}), ` +
                        `retrying in ${seconds.toFixed(0)}s`,
                );
                await this.sleep(seconds);
                wait *= this.exponentialFactor;
                attempt += 1;
            }
        }
    }
}

/** Wraps a Conversation so each turn inherits rate-limit retries. */
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

    /** Delegate to `conversation.send`, retrying on rate-limit errors. */
    send(results?: ToolResult[]): Promise<ToolUseResponse> {
        return this.retry(() => this.conversation.send(results));
    }
}
