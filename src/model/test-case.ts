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
 * `code` is always a line Playwright MCP emitted, never one the LLM wrote.
 */
export const StepStatementSchema = z.object({
    code: z.string(),
    // why this line was accepted; informational only.
    reason: z.string().default(''),
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

export type StepStatement = z.infer<typeof StepStatementSchema>;
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;
export type Module = z.infer<typeof ModuleSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
