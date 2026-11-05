/** Helpers for the Validator: failure feedback, measured timeouts, prompt text. */

import type {
    PlacedStatement,
    StepRef,
    StepStatement,
    TestCase,
} from '../model/test-case.ts';
import type { BrowserError } from './browser.ts';

// How long a Playwright assertion waits when given no timeout.
const DEFAULT_ASSERTION_TIMEOUT_MS = 5_000;

// An assertion's timeout allows this many times its measured wait, as the
// site may be slower on another run.
const ASSERTION_TIMEOUT_MARGIN = 2;

/** A statement that failed on the page, as feedback for its step. */
export interface StepFailure {
    ref: StepRef;
    /** What failed and why, for the agent that re-extracts the step. */
    feedback: string;
}

/**
 * Turn a failed run of `placed` into feedback for the failing step.
 *
 * @param placed - The statements that were run, in order.
 * @param error - Where and why the run failed.
 * @param lead - What was being run, as the feedback's first line.
 * @returns The failing step, and the failure with the statements of that
 *   step that ran before it.
 */
export function failureAt(
    placed: PlacedStatement[],
    error: BrowserError,
    lead: string,
): StepFailure {
    const index = error.durations.length;
    const failed = placed[index];
    if (failed === undefined) {
        throw new RangeError(`No statement ${index} among ${placed.length}`);
    }
    const sameStep = placed
        .slice(0, index)
        .filter(({ ref }) => sameRef(ref, failed.ref))
        .map(({ statement }) => statement.code);
    const preceding =
        sameStep.length === 0
            ? ''
            : `\nThese statements of this step ran first, without error:\n` +
              `${sameStep.join('\n')}\n`;
    return {
        ref: failed.ref,
        feedback: `${lead}\n${error.code}\n${error.reason}\n${preceding}`,
    };
}

/**
 * Give each assertion the larger of its timeout and the one its measured
 * wait calls for; statements past `durations` (after a failure) keep theirs.
 */
export function withTimeouts(testCase: TestCase, durations: number[]): TestCase {
    let index = 0;
    return {
        ...testCase,
        modules: testCase.modules.map((module) => ({
            ...module,
            execution_steps: module.execution_steps.map((step) => ({
                ...step,
                statements: step.statements.map((statement) => {
                    const measured = durations[index++];
                    if (statement.type !== 'assertion' || measured === undefined) {
                        return statement;
                    }
                    const fitted =
                        Math.ceil((measured * ASSERTION_TIMEOUT_MARGIN) / 1000) * 1000;
                    const timeout = Math.max(
                        statement.timeout ?? 0,
                        fitted > DEFAULT_ASSERTION_TIMEOUT_MS ? fitted : 0,
                    );
                    return timeout === 0 ? statement : { ...statement, timeout };
                }),
            })),
        })),
    };
}

/** Render `statements` as a numbered list, one line per statement. */
export function numbered(statements: StepStatement[]): string {
    return statements
        .map((statement, index) => `${index + 1}. ${statement.code}`)
        .join('\n');
}

/** Trim a Playwright error, which can carry a very long call log. */
export function trim(message: string, limit = 1200): string {
    const trimmed = message.trim();
    return trimmed.length <= limit
        ? trimmed
        : `${trimmed.slice(0, limit)}\n... (truncated)`;
}

function sameRef(a: StepRef, b: StepRef): boolean {
    return a.module === b.module && a.step === b.step;
}
