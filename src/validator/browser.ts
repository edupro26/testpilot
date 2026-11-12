/**
 * The validation browser: runs validated statements, and nothing else.
 *
 * The pipeline's ground truth: no failed attempts or implicit waits, exactly
 * the code the Generator will ship. Every statement is timed and may wait up
 * to a ceiling, so late content is measured rather than failed. State is
 * cumulative across runs until a reset.
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
import { BrowserLaunchError, errorMessage } from '../runtime/exceptions.ts';
import { trim } from './utils.ts';

// How long any action or assertion may wait in a replay: Playwright MCP's own
// limit on `browser_wait_for`.
const REPLAY_TIMEOUT_MS = 30_000;

/** Chromium arguments for both pipeline browsers, so a page behaves the same. */
export const CHROMIUM_ARGS: readonly string[] = [
    '--disable-blink-features=AutomationControlled',
];

/** Raised when a statement fails to execute against the live page. */
export class BrowserError extends Error {
    override name = 'BrowserError';
    readonly code: string;
    readonly reason: string;
    readonly durations: number[];

    /**
     * Initialize with the offending statement and Playwright's reason.
     *
     * @param code - The statement that failed.
     * @param reason - Playwright's error message, trimmed.
     * @param durations - How long each statement before it took, in ms.
     * @param options - The underlying error, as `cause`.
     */
    constructor(
        code: string,
        reason: string,
        durations: number[] = [],
        options?: ErrorOptions,
    ) {
        super(`${code}\n${reason}`, options);
        this.code = code;
        this.reason = reason;
        this.durations = durations;
    }
}

/**
 * Execute `statements` against `page`, in order, each action and assertion
 * waiting up to `timeoutMs`.
 *
 * @returns How long each statement took, in ms.
 * @throws {BrowserError} If a statement fails on the page. Errors in the code
 *   itself (a syntax error, a name not in scope) propagate as they are.
 */
export async function runStatements(
    page: Page,
    statements: StepStatement[],
    timeoutMs = REPLAY_TIMEOUT_MS,
): Promise<number[]> {
    page.setDefaultTimeout(timeoutMs);
    const patient = expect.configure({ timeout: timeoutMs });
    const durations: number[] = [];
    for (const statement of statements) {
        const execute = compileStatement(statement.code);
        const started = performance.now();
        try {
            await execute(page, patient);
        } catch (error) {
            if (error instanceof ReferenceError || error instanceof TypeError) {
                throw error;
            }
            throw new BrowserError(statement.code, trim(String(error)), durations, {
                cause: error,
            });
        }
        durations.push(performance.now() - started);
        logger.debug(`Replayed: ${statement.code}`);
    }
    return durations;
}

/**
 * Launch Chromium the way both pipeline browsers need it.
 *
 * @param headless - Whether to run without a window.
 * @returns The browser.
 * @throws {BrowserLaunchError} If Chromium cannot be launched.
 */
export async function launchChromium(headless: boolean): Promise<Browser> {
    try {
        return await chromium.launch({ headless, args: [...CHROMIUM_ARGS] });
    } catch (error) {
        throw new BrowserLaunchError(
            `Could not launch Chromium: ${errorMessage(error)}`,
            { code: 'BROWSER_LAUNCH_FAILED', cause: error },
        );
    }
}

/** Options for `ValidationBrowser.launch`. */
export interface LaunchOptions {
    /** Whether to run the browser headless. */
    headless?: boolean;
    /** The context locale; must match the MCP browser and the generated script. */
    locale?: string;
    /** How long any action or assertion may wait, in ms. */
    timeoutMs?: number;
}

/** What the Validator needs from the browser that replays its statements. */
export interface ReplayBrowser {
    /** Execute `statements` in order; resolves to how long each took, in ms. */
    run(statements: StepStatement[]): Promise<number[]>;
    /** Discard all state, leaving a blank page. */
    reset(): Promise<void>;
}

/** A live Playwright page replaying validated statements. */
export class ValidationBrowser implements ReplayBrowser, AsyncDisposable {
    private readonly browser: Browser;
    private readonly locale: string;
    private readonly timeoutMs: number;
    private context: BrowserContext;
    private page: Page;

    private constructor(
        browser: Browser,
        locale: string,
        timeoutMs: number,
        context: BrowserContext,
        page: Page,
    ) {
        this.browser = browser;
        this.locale = locale;
        this.timeoutMs = timeoutMs;
        this.context = context;
        this.page = page;
    }

    /** Launch the validation browser, on a blank page. */
    static async launch({
        headless = true,
        locale = 'en-US',
        timeoutMs = REPLAY_TIMEOUT_MS,
    }: LaunchOptions = {}): Promise<ValidationBrowser> {
        const browser = await launchChromium(headless);
        try {
            const context = await browser.newContext({ locale });
            const page = await context.newPage();
            logger.debug(`Validation browser launched (locale=${locale})`);
            return new ValidationBrowser(browser, locale, timeoutMs, context, page);
        } catch (error) {
            await browser.close();
            throw error;
        }
    }

    /**
     * Execute `statements` against the live page, in order.
     *
     * @returns How long each statement took, in ms.
     * @throws {BrowserError} If a statement fails on the page.
     */
    run(statements: StepStatement[]): Promise<number[]> {
        return runStatements(this.page, statements, this.timeoutMs);
    }

    /** Discard all state, cookies included. */
    async reset(): Promise<void> {
        await this.context.close();
        this.context = await this.browser.newContext({ locale: this.locale });
        this.page = await this.context.newPage();
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
