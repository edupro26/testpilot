/**
 * The validation browser: runs validated statements, and nothing else.
 *
 * The pipeline's ground truth. Unlike the MCP browser, it carries no failed
 * attempts or implicit waits, and runs exactly what the Generator will ship.
 * State is cumulative across steps, as in the finished script.
 */

import {
    type Browser,
    type BrowserContext,
    chromium,
    expect,
    type Page,
} from '@playwright/test';

import { compileStatement } from '../extractor/utils.ts';
import { logger } from '../logger.ts';
import type { StepStatement } from '../model/test-case.ts';

/** Raised when a statement fails to execute against the live page. */
export class BrowserError extends Error {
    override name = 'BrowserError';
    readonly code: string;
    readonly reason: string;
    readonly ran: string[];

    /**
     * Initialize with the offending statement and Playwright's reason.
     *
     * @param code - The statement that failed.
     * @param reason - Playwright's error message, trimmed.
     * @param ran - Statements that ran before it in the same call.
     * @param options - The underlying error, as `cause`.
     */
    constructor(
        code: string,
        reason: string,
        ran: string[] = [],
        options?: ErrorOptions,
    ) {
        super(`${code}\n${reason}`, options);
        this.code = code;
        this.reason = reason;
        this.ran = ran;
    }
}

/** Options for `ValidationBrowser.launch`. */
export interface LaunchOptions {
    /** Whether to run the browser headless. */
    headless?: boolean;
    /**
     * The context locale (`Accept-Language`); must match the MCP browser and the
     * generated script.
     */
    locale?: string;
}

/** What the Validator needs from the browser that replays its statements. */
export interface ReplayBrowser {
    /** The page statements are replayed against. */
    readonly page: Pick<Page, 'url' | 'title'>;
    /** Execute `statements` against the live page, in order. */
    run(statements: StepStatement[]): Promise<void>;
}

/** A live Playwright page replaying validated statements. */
export class ValidationBrowser implements ReplayBrowser, AsyncDisposable {
    private readonly browser: Browser;
    private readonly locale: string;
    private context: BrowserContext;
    private currentPage: Page;

    private constructor(
        browser: Browser,
        locale: string,
        context: BrowserContext,
        page: Page,
    ) {
        this.browser = browser;
        this.locale = locale;
        this.context = context;
        this.currentPage = page;
    }

    /**
     * Launch the validation browser.
     *
     * @param options - Headless mode and locale.
     * @returns The browser, on a blank page.
     */
    static async launch({
        headless = true,
        locale = 'en-US',
    }: LaunchOptions = {}): Promise<ValidationBrowser> {
        const browser = await chromium.launch({ headless });
        const context = await browser.newContext({ locale });
        const page = await context.newPage();
        logger.debug(`Validation browser launched (locale=${locale})`);
        return new ValidationBrowser(browser, locale, context, page);
    }

    /** The page statements are replayed against. */
    get page(): Page {
        return this.currentPage;
    }

    /**
     * Execute `statements` against the live page, in order.
     *
     * Each statement runs with only `page` and `expect` in scope.
     *
     * @param statements - The step's statements, as collected.
     * @throws {BrowserError} If a statement fails on the page. The error names
     *   the statement and Playwright's reason, which is fed back to the agent
     *   as retry feedback. Errors in the code itself (it does not parse, or
     *   uses a name that is not in scope) propagate as they are.
     */
    async run(statements: StepStatement[]): Promise<void> {
        const ran: string[] = [];
        for (const statement of statements) {
            const execute = compileStatement(statement.code);
            try {
                await execute(this.currentPage, expect);
            } catch (error) {
                if (error instanceof ReferenceError || error instanceof TypeError) {
                    throw error;
                }
                throw new BrowserError(statement.code, trim(String(error)), ran, {
                    cause: error,
                });
            }
            ran.push(statement.code);
            logger.debug(`Replayed: ${statement.code}`);
        }
    }

    /** Discard all state, cookies included, to re-run a prefix after a failure. */
    async reset(): Promise<void> {
        await this.context.close();
        this.context = await this.browser.newContext({ locale: this.locale });
        this.currentPage = await this.context.newPage();
        logger.debug('Validation browser reset');
    }

    /** Shut the browser down. */
    async close(): Promise<void> {
        await this.browser.close();
        logger.debug('Validation browser closed');
    }

    /** Close the browser when leaving an `await using` block. */
    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

/** Trim a Playwright error, which can carry a very long call log. */
function trim(message: string, limit = 1200): string {
    const trimmed = message.trim();
    return trimmed.length <= limit
        ? trimmed
        : `${trimmed.slice(0, limit)}\n... (truncated)`;
}
