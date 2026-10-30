/** Helpers for the Extractor: prompt context, collection checks, step rebuilding. */

import { ExtractorError } from '../exceptions.ts';
import type { ExecutionStep, Module, StepStatement } from '../model/test-case.ts';

const AsyncFunction = async function () {
    /* only its constructor is used */
}.constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;

/**
 * Compile one statement into a function of `page` and `expect`, without running it.
 *
 * @param code - The statement, e.g. `await page.goto('https://example.com');`.
 * @returns A function that runs the statement against the given page.
 * @throws {SyntaxError} If `code` does not parse on its own.
 */
export function compileStatement(
    code: string,
): (page: unknown, expect: unknown) => Promise<void> {
    return new AsyncFunction('page', 'expect', code);
}

/**
 * Describe what the browser is already showing, for the agent's prompt.
 *
 * @param module - The module the step belongs to.
 * @param history - Statements already accepted for earlier steps.
 * @param resetTo - The URL a freshly reset MCP browser was sent to, when
 *   retrying. Earlier steps' state is then gone from it.
 * @returns A short natural-language briefing.
 */
export function describeBrowserContext(
    module: Module,
    history: string[],
    resetTo?: string,
): string {
    const done = history.map((code) => `  ${code}`).join('\n');

    if (resetTo !== undefined) {
        const fresh =
            `The browser was just reset for this retry: it is a fresh session ` +
            `(no cookies, no login, nothing stored) open at ${resetTo}.`;
        if (history.length === 0) {
            return `${fresh} Nothing else has been done yet.`;
        }
        return (
            `${fresh} Earlier steps ran this code in the previous session:\n` +
            `${done}\n` +
            `Only the URL survived the reset; their other effects (a login, a ` +
            `cart, filled fields) are gone. First redo whatever of that setup ` +
            `this step depends on, WITHOUT reporting those statements in ` +
            `step_done. Then perform this step and report only its own ` +
            `statements.`
        );
    }

    if (history.length === 0) {
        return (
            `Nothing has been done yet. The browser is on a blank page. ` +
            `This test case starts at ${module.url}.`
        );
    }
    return (
        `The browser is live and earlier steps have already run exactly ` +
        `this code:\n${done}\n` +
        `Do not repeat that work -- continue from the current page state. ` +
        `This module's page is ${module.url}.`
    );
}

/**
 * Rebuild `module`'s steps with their collected statements attached.
 *
 * @param module - The module whose steps to rebuild.
 * @param statementsByStep - One list of statements per execution step.
 * @returns The rebuilt execution steps.
 */
export function toExecutionSteps(
    module: Module,
    statementsByStep: StepStatement[][],
): ExecutionStep[] {
    if (statementsByStep.length !== module.execution_steps.length) {
        throw new Error(
            `Got statements for ${statementsByStep.length} step(s), ` +
                `expected ${module.execution_steps.length}`,
        );
    }
    return module.execution_steps.map((step, index) => ({
        step: step.step,
        statements: statementsByStep[index] ?? [],
    }));
}

/**
 * Reject a statement that does not parse on its own.
 *
 * Backstop for a collectable tool that starts emitting a statement spread
 * over several lines upstream: fail here, naming it, not in the replay or
 * the generated script.
 *
 * @param code - The collected statement.
 * @param step - The step's text, for the error message.
 * @throws {ExtractorError} If `code` is not a complete statement.
 */
export function requireStatement(code: string, step: string): void {
    try {
        compileStatement(code);
    } catch (error) {
        throw new ExtractorError(
            `Step ${JSON.stringify(step)} collected a statement that does not parse ` +
                `on its own -- the tool that emitted it spreads a statement over ` +
                `several lines and must be removed from COLLECTABLE_TOOLS:\n` +
                `  ${code}\n  (${String(error)})`,
            { cause: error },
        );
    }
}
