/**
 * The test case JSON contract, shared across the pipeline stages.
 *
 * The structured and validated test cases aren't separate schemas -- they
 * differ only in whether `statements` has been filled in yet (empty from the
 * Structurer, populated by the Extractor and proven by the Validator).
 */

import { z } from 'zod';

/**
 * One validated Playwright statement belonging to an execution step.
 *
 * `code` is a line Playwright MCP emitted, verbatim. `timeout` (ms) is an
 * assertion's measured wait, when Playwright's default is too short.
 */
export const StepStatementSchema = z
    .object({
        code: z.string(),
        // why this line was accepted; informational only.
        reason: z.string().default(''),
        type: z.enum(['action', 'assertion']),
        timeout: z.number().int().positive().optional(),
    })
    .refine((statement) => statement.type === 'assertion' || !statement.timeout, {
        message: 'only an assertion takes a timeout',
        path: ['timeout'],
    });

/** A single step within a module. */
export const ExecutionStepSchema = z.object({
    step: z.string(),
    statements: z.array(StepStatementSchema).default([]),
});

/** A page the test case interacts with, and the steps performed on it. */
export const ModuleSchema = z.object({
    url: z.string(),
    description: z.string(),
    execution_steps: z.array(ExecutionStepSchema),
});

/** The full structured test case. */
export const TestCaseSchema = z.object({
    name: z.string(),
    modules: z.array(ModuleSchema),
});

/** A validated statement, as `StepStatementSchema` parses it. */
export type StepStatement = z.infer<typeof StepStatementSchema>;
/** A step and its statements, as `ExecutionStepSchema` parses it. */
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;
/** A module of a test case, as `ModuleSchema` parses it. */
export type Module = z.infer<typeof ModuleSchema>;
/** A full test case, as `TestCaseSchema` parses it. */
export type TestCase = z.infer<typeof TestCaseSchema>;

/** Where a step sits in a test case, by module and step index. */
export interface StepRef {
    module: number;
    step: number;
}

/** A statement, with the step it belongs to. */
export interface PlacedStatement {
    ref: StepRef;
    statement: StepStatement;
}

/** A not yet judged statement; an awaited `expect(...)` is an assertion. */
export function statement(code: string): StepStatement {
    const type = code.trimStart().startsWith('await expect(') ? 'assertion' : 'action';
    return { code, reason: '', type };
}

/**
 * A test case's statements in run order, each with its step; only those of
 * the steps before `before`, when given.
 */
export function placeStatements(
    testCase: TestCase,
    before?: StepRef,
): PlacedStatement[] {
    const placed: PlacedStatement[] = [];
    testCase.modules.forEach((module, moduleIndex) => {
        module.execution_steps.forEach((step, stepIndex) => {
            const ref = { module: moduleIndex, step: stepIndex };
            if (before !== undefined && !isBefore(ref, before)) {
                return;
            }
            for (const entry of step.statements) {
                placed.push({ ref, statement: entry });
            }
        });
    });
    return placed;
}

/** Whether step `a` runs before step `b`. */
function isBefore(a: StepRef, b: StepRef): boolean {
    return a.module < b.module || (a.module === b.module && a.step < b.step);
}
