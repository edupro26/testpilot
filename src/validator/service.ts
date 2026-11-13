/**
 * Validator service: judge what each step tests, then prove the whole script.
 *
 * 1. Judge (an LLM call per step report, during extraction): does the code
 *    test what the step asks?
 * 2. Replay (once every step is extracted): does the whole script run back to
 *    back in a clean browser? Late assertions get a measured timeout.
 */

import type { Page } from '@playwright/test';
import { z } from 'zod';

import { completeJson, type LLMProvider } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import {
    placeStatements,
    type StepStatement,
    type TestCase,
} from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import { ValidatorError } from '../runtime/exceptions.ts';
import { BrowserError, type ReplayBrowser } from './browser.ts';
import { failureAt, numbered, type StepFailure, withTimeouts } from './utils.ts';

/** A replay's outcome; `testCase` carries the timeouts measured so far. */
export type Validation =
    | { ok: true; testCase: TestCase; runTimeMs: number }
    | { ok: false; testCase: TestCase; failure: StepFailure };

/**
 * The outcome of validating one execution step.
 *
 * `statements` are the accepted statements with their `reason` filled in;
 * empty when the step is rejected.
 */
export class StepVerdict {
    readonly isValid: boolean;
    readonly reason: string;
    readonly statements: StepStatement[];

    /**
     * Build a verdict.
     *
     * @param verdict - Whether the step is valid, why, and the accepted
     *   statements.
     */
    constructor({
        isValid,
        reason = '',
        statements = [],
    }: {
        isValid: boolean;
        reason?: string;
        statements?: StepStatement[];
    }) {
        this.isValid = isValid;
        this.reason = reason;
        this.statements = statements;
    }

    /** Why the step was rejected, for the Extractor's retry. */
    get feedback(): string {
        return this.isValid ? '' : this.reason;
    }
}

/** The semantic check's JSON reply. */
const SemanticVerdictSchema = z.object({
    is_valid: z.boolean(),
    reason: z.string().default(''),
    statement_reasons: z.array(z.string()).default([]),
});

/** Judges each step's statements, then proves the whole script. */
export class Validator {
    private readonly llm: LLMProvider;
    private readonly browser: ReplayBrowser;

    /**
     * Initialize with the LLM provider and validation browser to use.
     *
     * @param llm - Performs the semantic judgement.
     * @param browser - The validation browser, shared across the run and reset
     *   before each round.
     */
    constructor(llm: LLMProvider, browser: ReplayBrowser) {
        this.llm = llm;
        this.browser = browser;
    }

    /**
     * Replay the whole script back to back in a clean browser, as it will run.
     *
     * An assertion that needed longer than Playwright's default gets twice
     * its measured wait as timeout, keeping any larger one from an earlier
     * round. The first failure ends the round.
     *
     * @param testCase - The test case whose statements to replay, in run order.
     * @returns The test case with the measured timeouts and, if every statement
     *   passed, the run time in ms; otherwise the failed statement and its step.
     */
    async validate(testCase: TestCase): Promise<Validation> {
        const placed = placeStatements(testCase);
        if (placed.length === 0) {
            return { ok: true, testCase, runTimeMs: 0 };
        }

        logger.info(`Replaying the whole script (${placed.length} statement(s))`);
        await this.browser.reset();
        const started = performance.now();
        let durations: number[];
        try {
            durations = await this.browser.run(placed.map((p) => p.statement));
        } catch (error) {
            if (!(error instanceof BrowserError)) {
                throw error;
            }
            logger.warning(`Replay failed: ${error.code}`);
            return {
                ok: false,
                testCase: withTimeouts(testCase, error.durations),
                failure: failureAt(
                    placed,
                    error,
                    'This statement failed when the whole script was replayed ' +
                        'in a clean browser, every statement back to back, as ' +
                        'the generated script runs them:',
                ),
            };
        }
        const runTimeMs = performance.now() - started;
        logger.info(`Replayed the whole script in ${(runTimeMs / 1000).toFixed(1)}s`);
        return { ok: true, testCase: withTimeouts(testCase, durations), runTimeMs };
    }

    /**
     * Ask the LLM whether the step's code, which just ran in the agent's
     * browser, does what the step asks.
     *
     * @param step - The execution step's text.
     * @param statements - The statements collected for it.
     * @param page - The agent's page, after the step.
     * @returns The verdict. A step with no statements is judged too: only the
     *   LLM can tell one that needs nothing from a check gone missing.
     * @throws {ValidatorError} If the LLM response is not valid JSON or does not
     *   match the expected shape.
     */
    async judge(
        step: string,
        statements: StepStatement[],
        page: Pick<Page, 'url' | 'title'>,
    ): Promise<StepVerdict> {
        const prompt = renderPrompt('validator', {
            step,
            code: statements.length === 0 ? '(no statements)' : numbered(statements),
            page_url: page.url(),
            page_title: await page.title(),
        });
        const semantic = await completeJson(this.llm, prompt, {
            schema: SemanticVerdictSchema,
            shape: 'the verdict shape',
            error: ValidatorError,
        });

        const outcome = semantic.is_valid ? 'passed' : `failed (${semantic.reason})`;
        logger.info(`Semantic check: ${outcome}`);
        if (!semantic.is_valid) {
            return new StepVerdict({ isValid: false, reason: semantic.reason });
        }

        let reasons = semantic.statement_reasons;
        if (reasons.length !== statements.length) {
            logger.warning(
                `Got ${reasons.length} statement reason(s) for ${statements.length} ` +
                    `statement(s), using the step's reason for each`,
            );
            reasons = statements.map(() => semantic.reason);
        }
        return new StepVerdict({
            isValid: true,
            reason: semantic.reason,
            statements: statements.map((statement, index) => ({
                ...statement,
                reason: reasons[index] ?? semantic.reason,
            })),
        });
    }
}
