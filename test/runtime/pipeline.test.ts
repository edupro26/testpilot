/** Tests for src/runtime/pipeline: the extract-then-validate loop. */

import { describe, expect, type Mock, test, vi } from 'vitest';

import type { StepResult } from '../../src/extractor/agent.ts';
import {
    statement,
    type StepRef,
    type StepStatement,
    type TestCase,
} from '../../src/model/test-case.ts';
import {
    ExtractorError,
    McpError,
    ValidatorError,
} from '../../src/runtime/exceptions.ts';
import {
    extractAndValidate,
    MAX_RETRIES,
    type RunProgress,
    type Stages,
} from '../../src/runtime/pipeline.ts';
import { BrowserError } from '../../src/validator/browser.ts';
import type { Validation } from '../../src/validator/service.ts';

const GOTO = "await page.goto('https://example.com/login');";
const CLICK = "await page.getByRole('button', { name: 'Login' }).click();";
const ASSERT = "await expect(page.getByText('Welcome')).toBeVisible();";

function statements(code: string): StepStatement[] {
    return [statement(code)];
}

/** A test case of empty steps, one list of step texts per module. */
function testCase(...modules: string[][]): TestCase {
    return {
        name: 'Login',
        modules: modules.map((steps, index) => ({
            url: `https://example.com/${index}`,
            description: `module ${index}`,
            execution_steps: steps.map((step) => ({ step, statements: [] })),
        })),
    };
}

/** Every step's statement codes, per step, in run order. */
function codes(result: TestCase): string[][] {
    return result.modules.flatMap((module) =>
        module.execution_steps.map((step) => step.statements.map((s) => s.code)),
    );
}

type Round = 'ok' | { ref: StepRef; feedback: string };

/**
 * Fake stages, scripted per call.
 *
 * @param extracted - Each extraction's result: statements the judge
 *   accepted, a result carrying a rejection, or an error.
 * @param rounds - Each validation round: a pass, or a failure at a step.
 */
function stages(
    extracted: (StepStatement[] | StepResult | Error)[],
    rounds: Round[] = ['ok'],
): Stages & {
    extractor: { runStep: Mock<Stages['extractor']['runStep']> };
    validator: { validate: Mock<Stages['validator']['validate']> };
    mcp: { reset: Mock<Stages['mcp']['reset']>; run: Mock<Stages['mcp']['run']> };
} {
    const runStep = vi.fn<Stages['extractor']['runStep']>();
    for (const result of extracted) {
        if (result instanceof Error) {
            runStep.mockRejectedValueOnce(result);
        } else {
            runStep.mockResolvedValueOnce(
                Array.isArray(result) ? { statements: result } : result,
            );
        }
    }
    const validate = vi.fn<Stages['validator']['validate']>();
    for (const round of rounds) {
        validate.mockImplementationOnce(async (validated): Promise<Validation> =>
            round === 'ok'
                ? { ok: true, testCase: validated, runTimeMs: 1234 }
                : { ok: false, testCase: validated, failure: round },
        );
    }
    return {
        extractor: { runStep },
        validator: { validate, judge: vi.fn() },
        mcp: {
            reset: vi.fn<Stages['mcp']['reset']>(),
            run: vi.fn<Stages['mcp']['run']>().mockResolvedValue([]),
            page: vi.fn(),
        },
    };
}

/** Each extraction's module and step index, and its feedback. */
function extractions(
    runStep: Mock<Stages['extractor']['runStep']>,
): [string, number, string | undefined][] {
    return runStep.mock.calls.map(([module, index, options]) => [
        module.url,
        index,
        options.feedback,
    ]);
}

describe('extractAndValidate', () => {
    test('extracts every step, then validates once', async () => {
        // The happy path: one agent loop per step, one replay of the whole
        // script, and no browser restored.
        const fake = stages([statements(GOTO), statements(CLICK)]);

        const { result, runTimeMs } = await extractAndValidate(
            testCase(['Open the login', 'Log in']),
            fake,
        );

        expect(codes(result)).toEqual([[GOTO], [CLICK]]);
        expect(runTimeMs).toBe(1234);
        expect(fake.validator.validate).toHaveBeenCalledOnce();
        expect(fake.mcp.reset).not.toHaveBeenCalled();
        // Each step is briefed on what the browser already ran.
        expect(fake.extractor.runStep.mock.calls[1]?.[2].history).toEqual([GOTO]);
    });

    test('a rejected or failing step alone is re-extracted, from the restored state', async () => {
        // A step the judge still rejects once the agent's repairs run out, and
        // one whose code fails the replay, go through the same re-extraction:
        // the agent's browser is brought to just before the step by running
        // the earlier steps' code, and the other steps keep their statements.
        const rejected = { statements: statements(CLICK), rejection: 'clicks Signup' };
        const fixed = statements(
            "await page.getByRole('button', { name: 'Sign in' }).click();",
        );
        const fake = stages(
            [statements(GOTO), rejected, statements(CLICK), statements(ASSERT), fixed],
            [
                { ref: { module: 0, step: 1 }, feedback: 'Timeout 30000ms exceeded' },
                'ok',
            ],
        );

        const { result } = await extractAndValidate(
            testCase(['Open the login', 'Log in', 'See the welcome']),
            fake,
        );

        expect(codes(result)).toEqual([[GOTO], [fixed[0]!.code], [ASSERT]]);
        expect(extractions(fake.extractor.runStep)).toEqual([
            ['https://example.com/0', 0, undefined],
            ['https://example.com/0', 1, undefined],
            ['https://example.com/0', 1, 'clicks Signup'],
            ['https://example.com/0', 2, undefined],
            ['https://example.com/0', 1, 'Timeout 30000ms exceeded'],
        ]);
        expect(fake.extractor.runStep.mock.calls[4]?.[2].history).toEqual([GOTO]);
        expect(fake.mcp.run.mock.calls).toEqual([
            [statements(GOTO)],
            [statements(GOTO)],
        ]);
        expect(fake.mcp.reset).toHaveBeenCalledTimes(2);
        expect(fake.validator.validate).toHaveBeenCalledTimes(2);
    });

    test('a restore that breaks re-extracts the step it broke at', async () => {
        // Restoring before module 1 runs module 0's code; if a statement of
        // module 0's second step fails there, that step is broken: it is
        // re-extracted first, then the step that was being restored for.
        const fixed = statements(
            "await page.getByRole('button', { name: 'Sign in' }).click();",
        );
        const fake = stages(
            [
                statements(GOTO),
                statements(CLICK),
                statements(ASSERT),
                fixed,
                statements(ASSERT),
            ],
            [{ ref: { module: 1, step: 0 }, feedback: 'not visible' }, 'ok'],
        );
        fake.mcp.run.mockRejectedValueOnce(
            new BrowserError(CLICK, 'Timeout 30000ms exceeded', [10]),
        );

        const { result } = await extractAndValidate(
            testCase(['Open the login', 'Log in'], ['See the welcome']),
            fake,
        );

        expect(
            extractions(fake.extractor.runStep).map(([url, index]) => [url, index]),
        ).toEqual([
            ['https://example.com/0', 0],
            ['https://example.com/0', 1],
            ['https://example.com/1', 0],
            ['https://example.com/0', 1],
            ['https://example.com/1', 0],
        ]);
        const restoreFeedback = extractions(fake.extractor.runStep)[3]?.[2] ?? '';
        expect(restoreFeedback).toContain(CLICK);
        expect(restoreFeedback).toContain('restore');
        expect(extractions(fake.extractor.runStep)[4]?.[2]).toBe('not visible');
        expect(codes(result)).toEqual([[GOTO], [fixed[0]!.code], [ASSERT]]);
    });

    test('the run ends once the retry budget is spent', async () => {
        // Every re-extraction spends the same run-wide budget.
        const rejected = { statements: statements(CLICK), rejection: 'still wrong' };
        const fake = stages(Array.from({ length: MAX_RETRIES + 1 }, () => rejected));

        const error = await extractAndValidate(testCase(['Log in']), fake).catch(
            (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(ValidatorError);
        expect((error as ValidatorError).code).toBe('STEP_VALIDATION_FAILED');
        expect(String(error)).toContain('Log in');
        expect(String(error)).toContain('still wrong');
        // The budget is the run's, not the step's: an earlier step may have
        // spent it.
        expect(String(error)).toContain(`the run's ${MAX_RETRIES} retries are spent`);
        expect(fake.extractor.runStep).toHaveBeenCalledTimes(1 + MAX_RETRIES);
        expect(fake.validator.validate).not.toHaveBeenCalled();
    });

    test('an Extractor or MCP error propagates rather than being retried', async () => {
        // A rejected statement or a dead MCP server is not feedback to act on.
        for (const error of [
            new ExtractorError('boom', { code: 'STEP_ABANDONED' }),
            new McpError('boom', { code: 'BROWSER_AGENT_FAILED' }),
        ]) {
            const fake = stages([error]);

            await expect(extractAndValidate(testCase(['Log in']), fake)).rejects.toBe(
                error,
            );
            expect(fake.mcp.reset).not.toHaveBeenCalled();
        }
    });

    describe('progress', () => {
        function progress(): RunProgress {
            return { stage: undefined, step: undefined };
        }

        test('names the stage, and the step of each extraction', async () => {
            // What the CLI reports when a run fails mid-way.
            const seen: RunProgress[] = [];
            const run = progress();
            const fake = stages([], []);
            fake.validator.validate.mockImplementation((validated) => {
                seen.push({ ...run });
                return Promise.resolve({ ok: true, testCase: validated, runTimeMs: 1 });
            });
            fake.extractor.runStep.mockImplementation(() => {
                seen.push({ ...run });
                return Promise.resolve({ statements: statements(CLICK) });
            });

            await extractAndValidate(testCase(['Open', 'Log in']), fake, run);

            expect(seen).toEqual([
                { stage: 'extract', step: 'Open', stepNumber: 1, stepCount: 2 },
                { stage: 'extract', step: 'Log in', stepNumber: 2, stepCount: 2 },
                { stage: 'validate', step: undefined },
            ]);
        });

        test('a failing replay names its step; its redo is extract', async () => {
            const run = progress();
            const fake = stages([], []);
            const seen: RunProgress[] = [];
            fake.validator.validate
                .mockImplementationOnce((validated) => {
                    seen.push({ ...run });
                    return Promise.resolve({
                        ok: false,
                        testCase: validated,
                        failure: { ref: { module: 0, step: 1 }, feedback: 'nope' },
                    });
                })
                .mockImplementationOnce((validated) => {
                    seen.push({ ...run });
                    return Promise.resolve({
                        ok: true,
                        testCase: validated,
                        runTimeMs: 1,
                    });
                });
            fake.extractor.runStep.mockImplementation(() => {
                seen.push({ ...run });
                return Promise.resolve({ statements: statements(CLICK) });
            });

            await extractAndValidate(testCase(['Open', 'Log in']), fake, run);

            // Open, Log in, replay (fails), re-extraction of Log in, replay.
            expect(seen).toEqual([
                { stage: 'extract', step: 'Open', stepNumber: 1, stepCount: 2 },
                { stage: 'extract', step: 'Log in', stepNumber: 2, stepCount: 2 },
                { stage: 'validate', step: undefined },
                { stage: 'extract', step: 'Log in', stepNumber: 2, stepCount: 2 },
                { stage: 'validate', step: undefined },
            ]);
        });

        test('keeps the failing replay step when the retries run out', async () => {
            const run = progress();
            const fake = stages([], []);
            fake.validator.validate.mockImplementation((validated) =>
                Promise.resolve({
                    ok: false,
                    testCase: validated,
                    failure: { ref: { module: 0, step: 0 }, feedback: 'nope' },
                }),
            );
            fake.extractor.runStep.mockResolvedValue({ statements: statements(GOTO) });

            await expect(
                extractAndValidate(testCase(['Open']), fake, run),
            ).rejects.toBeInstanceOf(ValidatorError);

            // The budget runs out inside `redo`, after the replay failed.
            expect(run.step).toBe('Open');
        });

        test('names its step when an earlier repair spends the retries', async () => {
            // Re-extracting module 1's step spends all but one retry; the next
            // restore breaks at "Log in", whose repair spends the last one.
            const run = progress();
            const rejected = { statements: statements(ASSERT), rejection: 'no' };
            const fake = stages(
                [
                    statements(GOTO),
                    statements(CLICK),
                    statements(ASSERT),
                    ...Array.from({ length: MAX_RETRIES - 1 }, () => rejected),
                    statements(CLICK),
                ],
                [{ ref: { module: 1, step: 0 }, feedback: 'not visible' }],
            );
            for (let i = 1; i < MAX_RETRIES; i++) {
                fake.mcp.run.mockResolvedValueOnce([]);
            }
            fake.mcp.run.mockRejectedValueOnce(
                new BrowserError(CLICK, 'Timeout 30000ms exceeded', [10]),
            );

            const error = await extractAndValidate(
                testCase(['Open', 'Log in'], ['See the welcome']),
                fake,
                run,
            ).catch((e: unknown) => e);

            expect(String(error)).toContain('"See the welcome" still failing');
            expect(run).toMatchObject({
                step: 'See the welcome',
                stepNumber: 3,
                stepCount: 3,
            });
        });
    });
});
