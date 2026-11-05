/** Tests for src/main: the pipeline's wiring and its extract-then-validate loop. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, type Mock, test, vi } from 'vitest';

import { ExtractorError, McpError, ValidatorError } from '../src/exceptions.ts';
import type { StepResult } from '../src/extractor/agent.ts';
import type { RunStepOptions } from '../src/extractor/service.ts';
import type { LLMProvider } from '../src/llm/protocol.ts';
import { MockProvider } from '../src/llm/provider/mock.ts';
import {
    CliExit,
    extractAndValidate,
    loadSettingsOrFail,
    MAX_RETRIES,
    runCli,
    type Stages,
} from '../src/main.ts';
import {
    type Module,
    statement,
    type StepRef,
    type StepStatement,
    type TestCase,
} from '../src/model/test-case.ts';
import { BrowserError } from '../src/validator/browser.ts';
import type { Validation } from '../src/validator/service.ts';
import { useIsolatedSettingsEnv } from './helpers.ts';

// The CLI tests run the real wiring offline: the LLM is a mock, and MCP, the
// validation browser and the extractor are faked (non-functional req 7).
const fakes = vi.hoisted(() => ({
    provider: undefined as LLMProvider | undefined,
    runStep: undefined as
        ((...args: unknown[]) => Promise<StepStatement[]>) | undefined,
}));

vi.mock('../src/llm/factory.ts', () => ({
    getLlmProvider: () => fakes.provider,
}));

vi.mock('../src/extractor/mcp/server.ts', () => ({
    playwrightServer: () => () => Promise.reject(new Error('no real server')),
    PlaywrightMCP: {
        connect: () =>
            Promise.resolve({
                reset: vi.fn(),
                run: () => Promise.resolve([]),
                page: () =>
                    Promise.resolve({
                        url: () => 'https://example.com',
                        title: () => Promise.resolve('Home'),
                    }),
                [Symbol.asyncDispose]: () => Promise.resolve(),
            }),
    },
}));

vi.mock('../src/validator/browser.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/validator/browser.ts')>()),
    ValidationBrowser: {
        launch: () =>
            Promise.resolve({
                run: (statements: unknown[]) =>
                    Promise.resolve(statements.map(() => 0)),
                reset: () => Promise.resolve(),
                [Symbol.asyncDispose]: () => Promise.resolve(),
            }),
    },
}));

vi.mock('../src/extractor/service.ts', () => ({
    Extractor: class {
        async runStep(
            module: Module,
            index: number,
            options: RunStepOptions,
        ): Promise<StepResult> {
            const statements = (await fakes.runStep?.(module, index, options)) ?? [];
            return options.check?.(statements) ?? { statements };
        }
    },
}));

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
        for (const error of [new ExtractorError('boom'), new McpError('boom')]) {
            const fake = stages([error]);

            await expect(extractAndValidate(testCase(['Log in']), fake)).rejects.toBe(
                error,
            );
            expect(fake.mcp.reset).not.toHaveBeenCalled();
        }
    });
});

describe('the CLI', () => {
    useIsolatedSettingsEnv();

    test('invalid configuration fails before any LLM call', () => {
        // A bad LLM_PROVIDER must not get as far as opening a browser.
        vi.stubEnv('LLM_PROVIDER', 'not-a-real-provider');

        expect(() => loadSettingsOrFail()).toThrow(CliExit);
    });

    const SMOKE_SCRIPT = `/** Smoke test. */

import { expect, test } from '@playwright/test';

test.use({ locale: 'en-US' });

/** Log in and see the welcome message. */
test('Smoke test', async ({ page }) => {
  // Click the login button
  ${CLICK}

  // Verify the welcome message
  ${ASSERT}
});
`;

    /** Run the CLI offline on a two-step test case; return its exit code. */
    async function runPipeline(generatorReply: string): Promise<[number, string]> {
        const markdownPath = path.join('automation', 'case.md');
        await mkdir('automation');
        await writeFile(markdownPath, '# Smoke test\n\nClick login, see the welcome.');

        const structurerJson = JSON.stringify({
            name: 'Smoke Test',
            modules: [
                {
                    url: 'https://example.com',
                    description: 'Home page',
                    execution_steps: [
                        { step: 'Click the login button' },
                        { step: 'Verify the welcome message' },
                    ],
                },
            ],
        });
        const verdict = JSON.stringify({ is_valid: true, reason: 'ok' });
        const responses = [structurerJson, verdict, verdict, generatorReply];
        fakes.provider = new MockProvider(() => responses.shift() ?? '');
        const extracted = [statements(CLICK), statements(ASSERT)];
        fakes.runStep = () => Promise.resolve(extracted.shift() ?? []);

        const exitCode = await runCli([markdownPath]);
        return [exitCode, path.join('output', 'automation')];
    }

    test('runs the full pipeline offline', async () => {
        // The CLI runs end to end and writes both artifacts, with no network.
        // Each step's statements must land on that step in the persisted JSON,
        // typed by their code.
        const [exitCode, outputDir] = await runPipeline(SMOKE_SCRIPT);

        expect(exitCode).toBe(0);

        const script = await readFile(path.join(outputDir, 'case.spec.ts'), 'utf8');
        expect(script).toContain(CLICK);
        expect(script).toContain(ASSERT);

        const persisted = JSON.parse(
            await readFile(path.join(outputDir, 'case.json'), 'utf8'),
        ) as {
            modules: {
                execution_steps: { statements: { code: string; type: string }[] }[];
            }[];
        };
        const steps = persisted.modules[0]?.execution_steps ?? [];
        expect(steps.map((step) => step.statements.map((s) => s.code))).toEqual([
            [CLICK],
            [ASSERT],
        ]);
        expect(steps.map((step) => step.statements.map((s) => s.type))).toEqual([
            ['action'],
            ['assertion'],
        ]);
    });

    test('a generation failure keeps the validated JSON', async () => {
        // Validation is the expensive part, so its JSON is on disk before generation.
        const [exitCode, outputDir] = await runPipeline('not a script at all');

        expect(exitCode).toBe(1);
        expect(existsSync(path.join(outputDir, 'case.json'))).toBe(true);
        expect(existsSync(path.join(outputDir, 'case.spec.ts'))).toBe(false);
    });

    test('a missing input file is a usage error', async () => {
        expect(await runCli(['missing.md'])).toBe(2);
    });
});
