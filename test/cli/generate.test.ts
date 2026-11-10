/** Tests for the generate command: the pipeline's wiring, run offline. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { APIConnectionError } from 'openai';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { runCli } from '../../src/cli/cli.ts';
import { loadSettingsOrFail } from '../../src/cli/errors.ts';
import { type GenerateResult, logFilePath } from '../../src/cli/generate.ts';
import { ERROR_CODES } from '../../src/error-codes.ts';
import type { StepResult } from '../../src/extractor/agent.ts';
import type { RunStepOptions } from '../../src/extractor/service.ts';
import type { LLMProvider } from '../../src/llm/protocol.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';
import { logger } from '../../src/logger.ts';
import {
    type Module,
    statement,
    type StepStatement,
} from '../../src/model/test-case.ts';
import { ExtractorError, MissingSettingsError } from '../../src/runtime/exceptions.ts';
import { outputPaths } from '../../src/runtime/pipeline.ts';
import {
    stderr,
    stdout,
    useCapturedOutput,
    useIsolatedSettingsEnv,
} from '../helpers.ts';

// The CLI tests run the real wiring offline: the LLM is a mock, and MCP, the
// validation browser and the extractor are faked (non-functional req 7).
const fakes = vi.hoisted(() => ({
    provider: undefined as LLMProvider | undefined,
    /** Thrown by the LLM factory, as a missing API key is. */
    providerError: undefined as Error | undefined,
    runStep: undefined as
        ((...args: unknown[]) => Promise<StepStatement[]>) | undefined,
    /** The options the agent's and the validation browser were opened with. */
    serverLocale: undefined as string | undefined,
    serverOptions: undefined as { headed?: boolean } | undefined,
    launchOptions: undefined as { headed?: boolean } | undefined,
}));

vi.mock('../../src/llm/factory.ts', () => ({
    getLlmProvider: () => {
        if (fakes.providerError !== undefined) {
            throw fakes.providerError;
        }
        return fakes.provider;
    },
}));

vi.mock('../../src/extractor/mcp/server.ts', () => ({
    playwrightServer: (locale: string, options?: { headed?: boolean }) => {
        fakes.serverLocale = locale;
        fakes.serverOptions = options;
        return () => Promise.reject(new Error('no real server'));
    },
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

vi.mock('../../src/validator/browser.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/validator/browser.ts')>()),
    ValidationBrowser: {
        launch: (options?: { headed?: boolean }) => {
            fakes.launchOptions = options;
            return Promise.resolve({
                run: (statements: unknown[]) =>
                    Promise.resolve(statements.map(() => 0)),
                reset: () => Promise.resolve(),
                [Symbol.asyncDispose]: () => Promise.resolve(),
            });
        },
    },
}));

vi.mock('../../src/extractor/service.ts', () => ({
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

const CLICK = "await page.getByRole('button', { name: 'Login' }).click();";
const ASSERT = "await expect(page.getByText('Welcome')).toBeVisible();";

function statements(code: string): StepStatement[] {
    return [statement(code)];
}

describe('the CLI', () => {
    useIsolatedSettingsEnv();
    useCapturedOutput();

    beforeEach(() => {
        fakes.providerError = undefined;
    });

    test('invalid configuration fails before any LLM call', () => {
        // A bad TESTPILOT_LLM_PROVIDER must not get as far as opening a browser.
        vi.stubEnv('TESTPILOT_LLM_PROVIDER', 'not-a-real-provider');

        expect(() => loadSettingsOrFail()).toThrow(
            expect.objectContaining({ exitCode: 2 }),
        );
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

    /** Script the fakes for a two-step test case, ending with `generatorReply`. */
    function fakePipeline(generatorReply: string): void {
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
    }

    /**
     * Run the CLI offline on a two-step test case; return its exit code.
     *
     * @param generatorReply - The generator's reply.
     * @param args - More arguments for `generate`.
     * @param arrange - Called once the fakes are scripted, to change them.
     */
    async function runPipeline(
        generatorReply: string,
        args: string[] = [],
        arrange?: () => void,
    ): Promise<[number, string]> {
        const markdownPath = path.join('automation', 'case.md');
        await mkdir('automation');
        await writeFile(markdownPath, '# Smoke test\n\nClick login, see the welcome.');
        fakePipeline(generatorReply);
        arrange?.();

        const exitCode = await runCli(['generate', markdownPath, ...args]);
        return [exitCode, path.join('.testpilot', 'tests')];
    }

    test('runs the full pipeline offline', async () => {
        // The CLI runs end to end and writes both artifacts, with no network.
        // Each step's statements must land on that step in the persisted JSON,
        // typed by their code.
        const [exitCode, testsDir] = await runPipeline(SMOKE_SCRIPT);

        expect(exitCode).toBe(0);

        const script = await readFile(path.join('testpilot', 'case.spec.ts'), 'utf8');
        expect(script).toContain(CLICK);
        expect(script).toContain(ASSERT);

        const persisted = JSON.parse(
            await readFile(path.join(testsDir, 'case.json'), 'utf8'),
        ) as {
            source: string;
            modules: {
                execution_steps: { statements: { code: string; type: string }[] }[];
            }[];
        };
        expect(persisted.source).toBe('automation/case.md');
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
        const [exitCode, testsDir] = await runPipeline('not a script at all');

        expect(exitCode).toBe(1);
        expect(existsSync(path.join(testsDir, 'case.json'))).toBe(true);
        expect(existsSync(path.join('testpilot', 'case.spec.ts'))).toBe(false);

        // The log file holds the failure too, and ends with its own path.
        const [name] = await readdir('.testpilot/logs');
        const log = await readFile(path.join('.testpilot/logs', name ?? ''), 'utf8');
        expect(log).toContain('[ERROR]');
        expect(log.trimEnd().split('\n').at(-1)).toContain(
            `Log: ${path.join('.testpilot', 'logs', name ?? '')}`,
        );
    });

    test('logFilePath names the log after the local start time and the input', () => {
        const now = new Date(2026, 10, 7, 9, 5, 3);
        expect(logFilePath('/p', 'login', now)).toBe(
            path.join('/p', '.testpilot', 'logs', '2026-11-07_09-05-03-login.log'),
        );
        expect(logFilePath('/p', 'login', now, 2)).toBe(
            path.join('/p', '.testpilot', 'logs', '2026-11-07_09-05-03_2-login.log'),
        );
    });

    test('runs that start in the same second get a log each', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date(2026, 10, 7, 9, 5, 3));
            expect((await runPipeline(SMOKE_SCRIPT))[0]).toBe(0);
            const firstRun = stdout().length;
            fakePipeline(SMOKE_SCRIPT);

            expect(await runCli(['generate', 'automation/case.md', '--json'])).toBe(0);

            const second = path.resolve(logFilePath('.', 'case', new Date(), 2));
            expect(JSON.parse(stdout().slice(firstRun))).toMatchObject({
                log: second,
            });
            expect((await readdir('.testpilot/logs')).sort()).toEqual([
                '2026-11-07_09-05-03-case.log',
                '2026-11-07_09-05-03_2-case.log',
            ]);
            const log = await readFile(second, 'utf8');
            expect(log.match(/Log: /g)).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    test('outputPaths puts the spec in scriptsDir, the JSON in .testpilot', () => {
        expect(outputPaths('cases/login.md', '/p', 'e2e/testpilot')).toEqual({
            spec: path.resolve('/p/e2e/testpilot/login.spec.ts'),
            testCase: path.resolve('/p/.testpilot/tests/login.json'),
        });
        expect(outputPaths('login.md', '/p', '/abs/specs').spec).toBe(
            path.resolve('/abs/specs/login.spec.ts'),
        );
    });

    test('an input named like another one is refused before the run', async () => {
        expect((await runPipeline(SMOKE_SCRIPT))[0]).toBe(0);
        const json = path.join('.testpilot', 'tests', 'case.json');
        const before = await readFile(json, 'utf8');
        await mkdir('other');
        await writeFile(path.join('other', 'case.md'), '# Another test');
        const firstRun = stdout().length;

        expect(await runCli(['generate', 'other/case.md', '--json'])).toBe(2);

        expect(stderr()).toContain(
            `OUTPUT_CONFLICT: ${json} was generated from automation/case.md; ` +
                'generating other/case.md would overwrite it and its script',
        );
        expect(JSON.parse(stdout().slice(firstRun))).toMatchObject({
            exitCode: 2,
            log: null,
            error: { code: 'OUTPUT_CONFLICT', type: 'OutputConflictError' },
        });
        expect(await readFile(json, 'utf8')).toBe(before);
        expect(await readdir('.testpilot/logs')).toHaveLength(1);
    });

    test('an input named like one being generated is refused while it runs', async () => {
        // Both would pass the JSON's check before either wrote it, then share
        // its outputs; the run holding them keeps them until both are written.
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let extracting = (): void => undefined;
        const started = new Promise<void>((resolve) => (extracting = resolve));
        const first = runPipeline(SMOKE_SCRIPT, ['--json'], () => {
            const extract = fakes.runStep;
            fakes.runStep = async (...args) => {
                extracting();
                await gate;
                return (await extract?.(...args)) ?? [];
            };
        });
        await started;
        await mkdir('other');
        await writeFile(path.join('other', 'case.md'), '# Another test');
        const json = path.join('.testpilot', 'tests', 'case.json');

        expect(await runCli(['generate', 'other/case.md', '--json'])).toBe(2);
        expect(stderr()).toContain(
            `OUTPUT_CONFLICT: ${json} is being generated from automation/case.md ` +
                `by another run (process ${process.pid}); generating other/case.md ` +
                'now would overwrite it and its script',
        );

        release();
        expect((await first)[0]).toBe(0);
        expect(JSON.parse(await readFile(json, 'utf8'))).toMatchObject({
            source: 'automation/case.md',
        });
        expect(existsSync(`${json}.lock`)).toBe(false);
    });

    test('a reservation left by a run that stopped is taken over', async () => {
        const tests = path.join('.testpilot', 'tests');
        await mkdir(tests, { recursive: true });
        const { pid } = spawnSync(process.execPath, ['-e', '']);
        const lock = path.join(tests, 'case.json.lock');
        await writeFile(lock, JSON.stringify({ pid, source: 'other/case.md' }));

        expect((await runPipeline(SMOKE_SCRIPT))[0]).toBe(0);
        expect(existsSync(lock)).toBe(false);

        // A failed run releases its reservation too.
        fakePipeline('not a script');
        expect(await runCli(['generate', 'automation/case.md'])).toBe(1);
        expect(existsSync(lock)).toBe(false);
    });

    test('the same input, or JSON that records no source, is overwritten', async () => {
        expect((await runPipeline(SMOKE_SCRIPT))[0]).toBe(0);
        fakePipeline(SMOKE_SCRIPT);
        expect(await runCli(['generate', 'automation/case.md'])).toBe(0);

        await writeFile(path.join('.testpilot', 'tests', 'case.json'), '{}');
        await writeFile('case.md', '# Smoke test');
        fakePipeline(SMOKE_SCRIPT);
        expect(await runCli(['generate', 'case.md'])).toBe(0);
    });

    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'a log file that cannot be created is a warning, and no log is reported',
        async () => {
            const logs = path.join('.testpilot', 'logs');
            await mkdir(logs, { recursive: true });
            await chmod(logs, 0o555);
            try {
                const [exitCode] = await runPipeline(SMOKE_SCRIPT, ['--json']);

                expect(exitCode).toBe(0);
                expect(JSON.parse(stdout())).toMatchObject({
                    status: 'success',
                    log: null,
                });
                expect(stderr()).toContain(
                    `Cannot create a log file in ${logs}, so this run has none: EACCES`,
                );
                expect(stderr()).not.toContain('Log: ');

                fakePipeline(SMOKE_SCRIPT);
                expect(await runCli(['generate', 'automation/case.md'])).toBe(0);
                expect(stdout()).toContain('log: (none)\n');
            } finally {
                await chmod(logs, 0o755);
            }
        },
    );

    test('each run writes a log file, and prints its path', async () => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT);
        expect(exitCode).toBe(0);
        const logs = await readdir('.testpilot/logs');
        expect(logs).toEqual([
            expect.stringMatching(/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-case\.log$/),
        ]);
        const log = await readFile(path.join('.testpilot/logs', logs[0]!), 'utf8');
        expect(log).toContain('Wrote generated script to');
        expect(log).not.toContain('\x1b[');
        const logLine = `Log: ${path.join('.testpilot', 'logs', logs[0]!)}`;
        expect(stderr()).toContain(logLine);
        expect(log.split('\n')[0]).toContain(logLine);
    });

    test('the log path is printed first and last whatever the log level', async () => {
        vi.stubEnv('TESTPILOT_LOG_LEVEL', 'ERROR');
        const [exitCode] = await runPipeline(SMOKE_SCRIPT);
        expect(exitCode).toBe(0);

        const [name] = await readdir('.testpilot/logs');
        const logLine = `Log: ${path.join('.testpilot', 'logs', name ?? '')}`;
        const log = await readFile(path.join('.testpilot/logs', name ?? ''), 'utf8');
        expect(log.trimEnd().split('\n')).toEqual([
            expect.stringContaining(logLine),
            expect.stringContaining(logLine),
        ]);
        expect(stderr().trimEnd().split('\n')).toEqual([
            expect.stringContaining(logLine),
            expect.stringContaining(logLine),
        ]);
    });

    test('a log folder that cannot be created is a setup error', async () => {
        await mkdir('.testpilot');
        await writeFile(path.join('.testpilot', 'logs'), 'in the way');
        await writeFile('case.md', '# Smoke test');

        expect(await runCli(['generate', 'case.md', '--json'])).toBe(2);
        expect(stderr()).toContain('LOG_DIR_FAILED: Cannot create the log folder');
        expect(stderr()).toContain(path.join('.testpilot', 'logs'));
        expect(JSON.parse(stdout())).toMatchObject({
            exitCode: 2,
            error: { code: 'LOG_DIR_FAILED', type: 'LogFolderError' },
        });
    });

    test('from a subfolder, the input is relative to it, outputs to root', async () => {
        const root = process.cwd();
        await mkdir('cases');
        await mkdir('src');
        await writeFile(path.join('cases', 'case.md'), '# Smoke test\n\nClick login.');
        fakePipeline(SMOKE_SCRIPT);
        process.chdir('src');

        expect(await runCli(['generate', '../cases/case.md'])).toBe(0);

        expect(existsSync(path.join(root, 'testpilot', 'case.spec.ts'))).toBe(true);
        expect(existsSync(path.join(root, '.testpilot', 'tests', 'case.json'))).toBe(
            true,
        );
        expect(stderr()).toContain(`Log: ${path.join('..', '.testpilot', 'logs')}`);
    });

    test('--out is relative to the working directory', async () => {
        const root = process.cwd();
        await mkdir('sub');
        await writeFile(path.join('sub', 'case.md'), '# Smoke test\n\nClick login.');
        fakePipeline(SMOKE_SCRIPT);
        process.chdir('sub');

        expect(await runCli(['generate', 'case.md', '--out=specs'])).toBe(0);

        expect(existsSync(path.join(root, 'sub', 'specs', 'case.spec.ts'))).toBe(true);
        expect(existsSync(path.join(root, 'testpilot'))).toBe(false);
    });

    test.each(['0', 'abc'])(
        '--max-turns=%s is a configuration error',
        async (turns) => {
            await writeFile('case.md', '# Smoke test');

            expect(await runCli(['generate', 'case.md', `--max-turns=${turns}`])).toBe(
                2,
            );
            expect(stderr()).toContain('--max-turns (from flag)');
        },
    );

    test.each(['--out=', '--locale='])('%s is a configuration error', async (flag) => {
        // An empty --out would otherwise write the spec to the working directory.
        await writeFile('case.md', '# Smoke test');

        expect(await runCli(['generate', 'case.md', flag])).toBe(2);
        expect(stderr()).toContain(`${flag.slice(0, -1)} (from flag)`);
    });

    test('--log-level takes effect for the whole run', async () => {
        vi.stubEnv('TESTPILOT_LOG_LEVEL', 'ERROR');
        await mkdir('automation');
        await writeFile(path.join('automation', 'case.md'), '# Smoke test');
        fakePipeline(SMOKE_SCRIPT);

        expect(
            await runCli(['generate', 'automation/case.md', '--log-level=debug']),
        ).toBe(0);

        const [name] = await readdir('.testpilot/logs');
        const log = await readFile(path.join('.testpilot/logs', name ?? ''), 'utf8');
        expect(log).toContain('[DEBUG]');
        expect(stderr()).toContain('Wrote generated script to');
    });

    test('--locale overrides the setting for the run', async () => {
        await writeFile('case.md', '# Smoke test\n\nClick login.');
        fakePipeline(SMOKE_SCRIPT.replace("'en-US'", "'pt-PT'"));

        expect(await runCli(['generate', 'case.md', '--locale=pt-PT'])).toBe(0);

        expect(fakes.serverLocale).toBe('pt-PT');
    });

    test('--headed reaches the agent browser only', async () => {
        await writeFile('case.md', '# Smoke test\n\nClick login.');
        fakePipeline(SMOKE_SCRIPT);

        expect(await runCli(['generate', 'case.md', '--headed'])).toBe(0);

        expect(fakes.serverOptions).toEqual({ headed: true, root: process.cwd() });
        expect(fakes.launchOptions?.headed).toBeUndefined();

        fakes.serverOptions = undefined;
        fakePipeline(SMOKE_SCRIPT);
        expect(await runCli(['generate', 'case.md'])).toBe(0);
        expect(fakes.serverOptions).toEqual({ headed: false, root: process.cwd() });
    });

    /**
     * Run the CLI with the first step taking seven 4-second agent turns, on fake
     * timers; return its exit code.
     *
     * @param onTurn - Called at the start of each turn, e.g. to log a line.
     */
    async function runSlowStep(onTurn: (turn: number) => void): Promise<number> {
        vi.useFakeTimers();
        try {
            let started: () => void = () => undefined;
            const stepStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            const running = runPipeline(SMOKE_SCRIPT, [], () => {
                fakes.runStep = vi
                    .fn<NonNullable<typeof fakes.runStep>>()
                    .mockImplementationOnce(async () => {
                        started();
                        for (let turn = 1; turn <= 7; turn++) {
                            onTurn(turn);
                            await new Promise((resolve) => setTimeout(resolve, 4_000));
                        }
                        return statements(CLICK);
                    })
                    .mockResolvedValueOnce(statements(ASSERT));
            });
            await stepStarted;
            await vi.advanceTimersByTimeAsync(28_000);
            const [exitCode] = await running;
            expect(vi.getTimerCount()).toBe(0);
            return exitCode;
        } finally {
            vi.useRealTimers();
        }
    }

    test('a step quiet for 10 s over several turns logs a heartbeat', async () => {
        // No single turn takes 10 s, but the run must not look stuck.
        expect(await runSlowStep(() => undefined)).toBe(0);

        const heartbeats = stderr()
            .split('\n')
            .filter((line) => line.includes('Waiting for'));
        // It repeats while the quiet lasts, counting from the last real line.
        const where =
            'Waiting for extract to finish: step 1 of 2, "Click the login button"';
        expect(heartbeats).toEqual([
            expect.stringContaining(`INFO\x1b[0m] ${where} (10s)`),
            expect.stringContaining(`INFO\x1b[0m] ${where} (20s)`),
        ]);
    });

    test('a run that keeps logging logs no heartbeat', async () => {
        expect(
            await runSlowStep((turn) => {
                logger.info(`Turn ${turn}`);
            }),
        ).toBe(0);

        expect(stderr()).toContain('Turn 7');
        expect(stderr()).not.toContain('Waiting for');
    });

    test('the heartbeat is logged whatever the log level', async () => {
        vi.stubEnv('TESTPILOT_LOG_LEVEL', 'WARNING');
        expect(await runSlowStep(() => undefined)).toBe(0);

        const heartbeats = stderr()
            .split('\n')
            .filter((line) => line.includes('Waiting for'));
        expect(heartbeats).toHaveLength(2);
    });

    test('the failure code and hint are logged whatever the log level', async () => {
        const [exitCode] = await runPipeline(
            SMOKE_SCRIPT,
            ['--log-level=critical'],
            () => {
                fakes.runStep = vi
                    .fn<NonNullable<typeof fakes.runStep>>()
                    .mockRejectedValueOnce(
                        new ExtractorError('out of turns', {
                            code: 'STEP_OUT_OF_TURNS',
                        }),
                    );
            },
        );

        expect(exitCode).toBe(1);
        expect(stderr()).toContain('STEP_OUT_OF_TURNS: out of turns');
        expect(stderr()).toContain(`Hint: ${ERROR_CODES.STEP_OUT_OF_TURNS.hint}`);
    });

    test('a missing input file is a usage error', async () => {
        expect(await runCli(['generate', 'missing.md'])).toBe(2);
        expect(stdout()).toBe('');
        expect(stderr()).toContain(
            `ERROR\x1b[0m] INPUT_NOT_FOUND: invalid value for '<markdown_path>': ` +
                'file "missing.md" does not exist.',
        );
        expect(stderr()).toContain(`Hint: ${ERROR_CODES.INPUT_NOT_FOUND.hint}`);
    });

    test('a failed run logs the code with the message, then the hint', async () => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT, [], () => {
            fakes.runStep = vi
                .fn<NonNullable<typeof fakes.runStep>>()
                .mockRejectedValueOnce(
                    new ExtractorError('out of turns', { code: 'STEP_OUT_OF_TURNS' }),
                );
        });

        expect(exitCode).toBe(1);
        expect(stderr()).toContain('STEP_OUT_OF_TURNS: out of turns');
        expect(stderr()).toContain(`Hint: ${ERROR_CODES.STEP_OUT_OF_TURNS.hint}`);
    });

    test('a successful run prints the three paths on stdout, relative', async () => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT);

        expect(exitCode).toBe(0);
        const [name] = await readdir('.testpilot/logs');
        expect(stdout()).toBe(
            `spec: ${path.join('testpilot', 'case.spec.ts')}\n` +
                `test case: ${path.join('.testpilot', 'tests', 'case.json')}\n` +
                `log: ${path.join('.testpilot', 'logs', name ?? '')}\n`,
        );
    });

    test('a failed run prints nothing on stdout', async () => {
        const [exitCode] = await runPipeline('not a script at all');

        expect(exitCode).toBe(1);
        expect(stdout()).toBe('');
    });

    test('--json prints one object with the paths on success', async () => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT, ['--json']);

        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout()) as GenerateResult;
        expect(stdout()).toBe(`${JSON.stringify(result, null, 2)}\n`);
        expect(result).toMatchObject({ status: 'success', exitCode: 0, error: null });
        expect(path.isAbsolute(result.spec!)).toBe(true);
        expect(existsSync(result.spec!)).toBe(true);
        expect(existsSync(result.testCase!)).toBe(true);
        expect(existsSync(result.log!)).toBe(true);
        // The progress log stays on stderr.
        expect(stderr()).toContain('Log: ');
    });

    test('--json reports the code and hint of an extraction failure', async () => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT, ['--json'], () => {
            fakes.runStep = vi
                .fn<NonNullable<typeof fakes.runStep>>()
                .mockResolvedValueOnce(statements(CLICK))
                .mockRejectedValueOnce(
                    new ExtractorError('out of turns', { code: 'STEP_OUT_OF_TURNS' }),
                );
        });

        expect(exitCode).toBe(1);
        const result = JSON.parse(stdout()) as GenerateResult;
        expect(result).toMatchObject({
            status: 'failure',
            exitCode: 1,
            spec: null,
            testCase: null,
            error: {
                code: 'STEP_OUT_OF_TURNS',
                hint: ERROR_CODES.STEP_OUT_OF_TURNS.hint,
                type: 'ExtractorError',
                stage: 'extract',
                step: 'Verify the welcome message',
                message: 'out of turns',
            },
        });
        expect(existsSync(result.log!)).toBe(true);
        expect(stdout()).not.toContain('Hint:');
        expect(stderr()).toContain('STEP_OUT_OF_TURNS: out of turns');
        expect(stderr()).toContain(`Hint: ${ERROR_CODES.STEP_OUT_OF_TURNS.hint}`);
    });

    test('an LLM connection failure mid-step keeps its stage and step', async () => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT, ['--json'], () => {
            fakes.runStep = vi
                .fn<NonNullable<typeof fakes.runStep>>()
                .mockResolvedValueOnce(statements(CLICK))
                .mockRejectedValueOnce(new APIConnectionError({ message: 'down' }));
        });

        expect(exitCode).toBe(1);
        expect(JSON.parse(stdout())).toMatchObject({
            error: {
                code: 'LLM_UNREACHABLE',
                stage: 'extract',
                step: 'Verify the welcome message',
            },
        });
    });

    test('--json after a generation failure keeps the test case path', async () => {
        const [exitCode] = await runPipeline('not a script at all', ['--json']);

        expect(exitCode).toBe(1);
        const result = JSON.parse(stdout()) as GenerateResult;
        expect(result).toMatchObject({
            spec: null,
            error: {
                code: 'SCRIPT_ASSEMBLY_FAILED',
                type: 'GeneratorError',
                stage: 'generate',
                step: null,
            },
        });
        expect(existsSync(result.testCase!)).toBe(true);
    });

    test('--json on an invalid configuration is still one object, exit 2', async () => {
        await mkdir('automation');
        await writeFile(path.join('automation', 'case.md'), '# Smoke test');
        vi.stubEnv('TESTPILOT_MAX_TURNS', 'abc');

        expect(await runCli(['generate', 'automation/case.md', '--json'])).toBe(2);

        const result = JSON.parse(stdout()) as GenerateResult;
        expect(result).toMatchObject({
            status: 'failure',
            exitCode: 2,
            spec: null,
            testCase: null,
            log: null,
            error: {
                code: 'CONFIG_INVALID',
                type: 'ConfigurationError',
                stage: null,
                step: null,
            },
        });
        expect(result.error?.message).toContain('TESTPILOT_MAX_TURNS');
    });

    test('--json on a missing input file is a UsageError, exit 2', async () => {
        expect(await runCli(['generate', 'missing.md', '--json'])).toBe(2);

        expect(JSON.parse(stdout())).toMatchObject({
            status: 'failure',
            exitCode: 2,
            log: null,
            error: {
                code: 'INPUT_NOT_FOUND',
                type: 'UsageError',
                stage: null,
                step: null,
                message:
                    "invalid value for '<markdown_path>': " +
                    'file "missing.md" does not exist.',
            },
        });
    });

    test('a missing API key found mid-run exits 2', async () => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT, ['--json'], () => {
            fakes.providerError = new MissingSettingsError(
                'Missing required TESTPILOT_AZURE_OPENAI_API_KEY',
            );
        });

        expect(exitCode).toBe(2);
        expect(JSON.parse(stdout())).toMatchObject({
            exitCode: 2,
            error: {
                code: 'LLM_SETTINGS_MISSING',
                type: 'MissingSettingsError',
                // The provider fails before the structure stage starts.
                stage: null,
                message: 'Missing required TESTPILOT_AZURE_OPENAI_API_KEY',
            },
        });
        // A setup error is the message alone; a stack trace would be noise.
        expect(stderr()).toContain(
            'LLM_SETTINGS_MISSING: Missing required TESTPILOT_AZURE_OPENAI_API_KEY',
        );
        expect(stderr()).not.toContain('\n    at ');
    });

    test.each([
        [401, 2],
        [500, 1],
    ])('an LLM %i exits %i, in the structure stage', async (status, expected) => {
        const [exitCode] = await runPipeline(SMOKE_SCRIPT, ['--json'], () => {
            fakes.provider = new MockProvider(() => {
                throw Object.assign(new Error(`HTTP ${status}`), { status });
            });
        });

        expect(exitCode).toBe(expected);
        expect(JSON.parse(stdout())).toMatchObject({
            exitCode: expected,
            error: { stage: 'structure', step: null },
        });
        // Only a failure to generate (exit 1) logs the stack trace.
        expect(stderr().includes(`Error: HTTP ${status}\n    at `)).toBe(
            expected === 1,
        );
    });

    test('the old bare form is rejected', async () => {
        expect(await runCli(['case.md'])).not.toBe(0);
        expect(stderr()).toContain("unknown command 'case.md'");
    });
});
