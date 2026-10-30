/** Tests for src/main: the pipeline's wiring and its retry-on-failure loop. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, type Mock, test, vi } from 'vitest';

import { ExtractorError, McpError, ValidatorError } from '../src/exceptions.ts';
import type { PlaywrightMCP } from '../src/extractor/mcp/server.ts';
import type { Extractor } from '../src/extractor/service.ts';
import type { LLMProvider } from '../src/llm/protocol.ts';
import { MockProvider } from '../src/llm/provider/mock.ts';
import { CliExit, extractStep, loadSettingsOrFail, runCli } from '../src/main.ts';
import type { Module, StepStatement } from '../src/model/test-case.ts';
import type { ValidationBrowser } from '../src/validator/browser.ts';
import { StepVerdict, type Validator } from '../src/validator/service.ts';
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
                callTool: vi.fn(),
                [Symbol.asyncDispose]: () => Promise.resolve(),
            }),
    },
}));

vi.mock('../src/validator/browser.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/validator/browser.ts')>()),
    ValidationBrowser: {
        launch: () =>
            Promise.resolve({
                page: {
                    url: () => 'https://example.com',
                    title: () => Promise.resolve('Home'),
                },
                run: () => Promise.resolve(),
                reset: () => Promise.resolve(),
                [Symbol.asyncDispose]: () => Promise.resolve(),
            }),
    },
}));

vi.mock('../src/extractor/service.ts', () => ({
    Extractor: class {
        runStep(...args: unknown[]): Promise<StepStatement[]> {
            return fakes.runStep?.(...args) ?? Promise.resolve([]);
        }
    },
}));

const CLICK = "await page.getByRole('button', { name: 'Login' }).click();";
const ASSERT = "await expect(page.getByText('Welcome')).toBeVisible();";

const MODULE: Module = {
    url: 'https://example.com/login',
    description: 'Login page',
    execution_steps: [{ step: 'Click the login button', statements: [] }],
};

function statements(code = CLICK): StepStatement[] {
    return [{ code, reason: '' }];
}

/** A fake extractor and validator, scripted per call. */
function stages(
    extracted: (StepStatement[] | Error)[],
    verdicts: StepVerdict[] = [],
): {
    extractor: { runStep: Mock<Extractor['runStep']> };
    validator: { run: Mock<Validator['run']> };
} {
    const runStep = vi.fn<Extractor['runStep']>();
    for (const result of extracted) {
        if (result instanceof Error) {
            runStep.mockRejectedValueOnce(result);
        } else {
            runStep.mockResolvedValueOnce(result);
        }
    }
    const run = vi.fn<Validator['run']>();
    for (const verdict of verdicts) {
        run.mockResolvedValueOnce(verdict);
    }
    return { extractor: { runStep }, validator: { run } };
}

/** A fake MCP connection and validation browser, for the retry wiring. */
function browsers(): {
    mcp: {
        reset: Mock<PlaywrightMCP['reset']>;
        callTool: Mock<PlaywrightMCP['callTool']>;
    };
    browser: {
        reset: Mock<ValidationBrowser['reset']>;
        run: Mock<ValidationBrowser['run']>;
        page: { url: () => string };
    };
} {
    return {
        mcp: {
            reset: vi.fn<PlaywrightMCP['reset']>(),
            callTool: vi.fn<PlaywrightMCP['callTool']>(),
        },
        browser: {
            reset: vi.fn<ValidationBrowser['reset']>(),
            run: vi.fn<ValidationBrowser['run']>(),
            page: { url: () => 'https://example.com/login' },
        },
    };
}

describe('extractStep', () => {
    test('a step that validates first time costs one loop and no reset', async () => {
        // The happy path: one agent loop, and no reconnect or page reload.
        const accepted = [{ code: CLICK, reason: 'clicks the login button' }];
        const { extractor, validator } = stages(
            [statements()],
            [new StepVerdict({ isValid: true, statements: accepted })],
        );
        const { mcp, browser } = browsers();

        const result = await extractStep(
            MODULE,
            0,
            extractor,
            validator,
            mcp,
            browser,
            [],
        );

        expect(result).toEqual(accepted);
        expect(extractor.runStep).toHaveBeenCalledTimes(1);
        expect(mcp.reset).not.toHaveBeenCalled();
        expect(browser.reset).not.toHaveBeenCalled();
    });

    test('a rejected step resets both browsers and retries with feedback', async () => {
        // A blind retry, or one against the failed attempt's state, is worthless.
        // Both browsers are reset (the MCP one would otherwise still carry, say, an
        // accepted cookie banner), the validated prefix is replayed, and the
        // rejection reaches the agent.
        const second = statements(
            "await page.getByRole('button', { name: 'Sign in' }).click();",
        );
        const rejection = new StepVerdict({
            isValid: false,
            reason: 'cookie banner blocked the click',
        });
        const { extractor, validator } = stages(
            [statements(), second],
            [rejection, new StepVerdict({ isValid: true, statements: second })],
        );
        const { mcp, browser } = browsers();
        const history = ["await page.goto('https://example.com');"];

        const result = await extractStep(
            MODULE,
            0,
            extractor,
            validator,
            mcp,
            browser,
            history,
        );

        expect(result).toEqual(second);
        expect(extractor.runStep).toHaveBeenCalledTimes(2);
        const retry = extractor.runStep.mock.calls[1]?.[2];
        expect(retry?.feedback).toBe(rejection.feedback);
        expect(retry?.resetTo).toBe('https://example.com/login');

        expect(mcp.reset).toHaveBeenCalledOnce();
        expect(browser.reset).toHaveBeenCalledOnce();
        expect(mcp.callTool).toHaveBeenCalledExactlyOnceWith('browser_navigate', {
            url: 'https://example.com/login',
        });
        const replayed = browser.run.mock.lastCall?.[0] ?? [];
        expect(replayed.map((s) => s.code)).toEqual(history);
    });

    test('a step failing twice aborts the run', async () => {
        // Functional req 5: retry once, then stop with a clear error.
        const wrong = new StepVerdict({ isValid: false, reason: 'still wrong' });
        const { extractor, validator } = stages(
            [statements(), statements()],
            [wrong, wrong],
        );
        const { mcp, browser } = browsers();

        const error = await extractStep(
            MODULE,
            0,
            extractor,
            validator,
            mcp,
            browser,
            [],
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ValidatorError);
        expect(String(error)).toMatch(/after retry/);
        expect(String(error)).toContain('still wrong');
        expect(extractor.runStep).toHaveBeenCalledTimes(2);
    });

    test.each([
        { name: 'ExtractorError', error: new ExtractorError('boom') },
        { name: 'McpError', error: new McpError('boom') },
    ])('$name propagates rather than being retried', async ({ error }) => {
        // A rejected statement or a dead MCP server is not a validation failure.
        const { extractor, validator } = stages([error]);
        const { mcp, browser } = browsers();

        await expect(
            extractStep(MODULE, 0, extractor, validator, mcp, browser, []),
        ).rejects.toBe(error);
        expect(validator.run).not.toHaveBeenCalled();
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
        // Each step's statements must land on that step in the persisted JSON.
        const [exitCode, outputDir] = await runPipeline(SMOKE_SCRIPT);

        expect(exitCode).toBe(0);

        const script = await readFile(path.join(outputDir, 'case.spec.ts'), 'utf8');
        expect(script).toContain(CLICK);
        expect(script).toContain(ASSERT);

        const persisted = JSON.parse(
            await readFile(path.join(outputDir, 'case.json'), 'utf8'),
        ) as { modules: { execution_steps: { statements: { code: string }[] }[] }[] };
        const steps = persisted.modules[0]?.execution_steps ?? [];
        expect(steps.map((step) => step.statements.map((s) => s.code))).toEqual([
            [CLICK],
            [ASSERT],
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
