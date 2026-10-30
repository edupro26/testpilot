/**
 * Validator service: prove a step's statements, then judge what they test.
 *
 * 1. Replay (deterministic): does the code run against a live page?
 * 2. Semantic (one LLM call): does it test what the step asked?
 */

import { z } from 'zod';

import { errorMessage, ValidatorError } from '../exceptions.ts';
import type { LLMProvider } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import type { StepStatement } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import { BrowserError, type ReplayBrowser } from './browser.ts';

const SYSTEM_PROMPT = 'You are an expert QA automation engineer.';

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

/** Proves a step's statements against a live page, then judges them. */
export class Validator {
    private readonly llm: LLMProvider;
    private readonly browser: ReplayBrowser;

    /**
     * Initialize with the LLM provider and validation browser to use.
     *
     * @param llm - Performs the semantic judgement.
     * @param browser - The cumulative validation browser, shared across the run.
     */
    constructor(llm: LLMProvider, browser: ReplayBrowser) {
        this.llm = llm;
        this.browser = browser;
    }

    /**
     * Validate one step's statements.
     *
     * @param step - The execution step's text.
     * @param statements - The statements collected for it.
     * @returns The verdict. A step with no statements is trivially valid.
     * @throws {ValidatorError} If the LLM response is not valid JSON or does not
     *   match the expected shape.
     */
    async run(step: string, statements: StepStatement[]): Promise<StepVerdict> {
        if (statements.length === 0) {
            logger.info('Step has no statements to validate');
            return new StepVerdict({
                isValid: true,
                reason: 'no browser interaction needed',
            });
        }

        logger.info(`Replaying ${statements.length} statement(s)`);
        try {
            await this.browser.run(statements);
        } catch (error) {
            if (!(error instanceof BrowserError)) {
                throw error;
            }
            logger.warning(`Replay failed: ${error.code}`);
            const preceding =
                error.ran.length === 0
                    ? ''
                    : `\nThese statements ran first, without error:\n${error.ran.join('\n')}\n`;
            return new StepVerdict({
                isValid: false,
                reason:
                    `This statement failed when replayed in a clean browser:\n` +
                    `${error.code}\n${error.reason}\n${preceding}`,
            });
        }

        return this.judge(step, statements);
    }

    /** Ask the LLM whether the proven code does what the step asked. */
    private async judge(
        step: string,
        statements: StepStatement[],
    ): Promise<StepVerdict> {
        const prompt = renderPrompt('validator', {
            step,
            code: numbered(statements),
            page_url: this.browser.page.url(),
            page_title: await this.browser.page.title(),
        });
        const response = await this.llm.complete({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: prompt,
            jsonMode: true,
        });
        logger.debug(`Raw LLM response (${response.length} chars): ${response}`);

        let data: unknown;
        try {
            data = JSON.parse(response);
        } catch (error) {
            throw new ValidatorError(
                `LLM response was not valid JSON: ${errorMessage(error)}`,
                {
                    cause: error,
                },
            );
        }

        const parsed = SemanticVerdictSchema.safeParse(data);
        if (!parsed.success) {
            throw new ValidatorError(
                `LLM response did not match the verdict shape: ${z.prettifyError(parsed.error)}`,
            );
        }
        const semantic = parsed.data;

        logger.info(
            `Semantic check: ${semantic.is_valid ? 'passed' : `failed (${semantic.reason})`}`,
        );
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

/** Render `statements` as a numbered list, one line per statement. */
function numbered(statements: StepStatement[]): string {
    return statements
        .map((statement, index) => `${index + 1}. ${statement.code}`)
        .join('\n');
}
