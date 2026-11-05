/** Helpers for the Extractor: compiling statements, prompt context, collection checks. */

import { ExtractorError } from '../exceptions.ts';
import type { Module } from '../model/test-case.ts';

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
 * A step that is re-extracted gets the same briefing: the pipeline restores
 * its browser by running the earlier steps' code in it.
 *
 * @param module - The module the step belongs to.
 * @param history - Statements already accepted for earlier steps.
 * @returns A short natural-language briefing.
 */
export function describeBrowserContext(module: Module, history: string[]): string {
    const done = history.map((code) => `  ${code}`).join('\n');

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
