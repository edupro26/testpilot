/** Tests for the generate command: the pipeline's wiring, run offline. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { runCli } from '../../src/cli/cli.ts';
import { loadSettingsOrFail } from '../../src/cli/errors.ts';
import type { StepResult } from '../../src/extractor/agent.ts';
import type { RunStepOptions } from '../../src/extractor/service.ts';
import type { LLMProvider } from '../../src/llm/protocol.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';
import {
    type Module,
    statement,
    type StepStatement,
} from '../../src/model/test-case.ts';
import { useIsolatedSettingsEnv } from '../helpers.ts';

// The CLI tests run the real wiring offline: the LLM is a mock, and MCP, the
// validation browser and the extractor are faked (non-functional req 7).
const fakes = vi.hoisted(() => ({
    provider: undefined as LLMProvider | undefined,
    runStep: undefined as
        ((...args: unknown[]) => Promise<StepStatement[]>) | undefined,
}));

vi.mock('../../src/llm/factory.ts', () => ({
    getLlmProvider: () => fakes.provider,
}));

vi.mock('../../src/extractor/mcp/server.ts', () => ({
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

vi.mock('../../src/validator/browser.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/validator/browser.ts')>()),
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

        const exitCode = await runCli(['generate', markdownPath]);
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
        expect(await runCli(['generate', 'missing.md'])).toBe(2);
    });

    test('the old bare form is rejected', async () => {
        expect(await runCli(['case.md'])).not.toBe(0);
    });
});
