/** Tests for the doctor command: each setup check and its fix. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';
import { afterEach, describe, expect, type MockInstance, test, vi } from 'vitest';

import { runCli } from '../../src/cli/cli.ts';
import {
    checkChromium,
    checkLlmSettings,
    checkNode,
    checkPlaywrightConfig,
    checkProjectPlaywright,
    compareVersions,
    findPlaywrightConfig,
    formatChecks,
    runChecks,
} from '../../src/cli/doctor.ts';
import { stdout, useCapturedOutput, useIsolatedSettingsEnv } from '../helpers.ts';

const AZURE_ENV = {
    TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    TESTPILOT_AZURE_OPENAI_API_KEY: 'fake-key',
    TESTPILOT_AZURE_DEPLOYMENT_NAME: 'fake-deployment',
    TESTPILOT_AZURE_MODEL_NAME: 'fake-model',
    TESTPILOT_OPENAI_API_VERSION: '2025-04-01-preview',
};

function emptyDir(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'testpilot-'));
}

/** A project folder whose `@playwright/test` is installed at `version`. */
async function projectWithPlaywright(version: string): Promise<string> {
    const root = await emptyDir();
    const pkg = path.join(root, 'node_modules', '@playwright', 'test');
    await mkdir(pkg, { recursive: true });
    await writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: '@playwright/test', version }),
    );
    return root;
}

test('Node.js below 24 fails', () => {
    expect(checkNode('24.0.0').status).toBe('ok');
    expect(checkNode('22.12.0')).toMatchObject({
        status: 'fail',
        fix: expect.stringContaining('24') as unknown,
    });
});

test('a Chromium that does not launch fails with the install command', async () => {
    expect((await checkChromium(() => Promise.resolve())).status).toBe('ok');

    const check = await checkChromium(() =>
        Promise.reject(new Error("Executable doesn't exist")),
    );
    expect(check.status).toBe('fail');
    expect(check.fix).toMatch(/npx playwright install chromium/);
});

test("the project's Playwright: missing fails, older warns, same passes", async () => {
    expect(checkProjectPlaywright(await emptyDir(), '1.64.1')).toMatchObject({
        status: 'fail',
        fix: 'npm init playwright@latest',
    });
    expect(
        checkProjectPlaywright(await projectWithPlaywright('1.50.0'), '1.64.1'),
    ).toMatchObject({
        status: 'warn',
        fix: expect.stringContaining('1.64.1') as unknown,
    });
    expect(
        checkProjectPlaywright(await projectWithPlaywright('1.64.1'), '1.64.1').status,
    ).toBe('ok');
});

test('a declared but uninstalled Playwright needs npm install, not a new scaffold', async () => {
    const root = await emptyDir();
    await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ devDependencies: { '@playwright/test': '^1.64.0' } }),
    );

    expect(checkProjectPlaywright(root, '1.64.1')).toMatchObject({
        status: 'fail',
        fix: 'npm install',
    });
});

test('an unreadable .env is a failed check, not a crash', async () => {
    const root = await emptyDir();
    await mkdir(path.join(root, '.env'));

    const check = checkLlmSettings(AZURE_ENV, root);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/\.env/);
});

test('a playwright.config of any extension is found', async () => {
    const root = await emptyDir();
    expect(findPlaywrightConfig(root)).toBeUndefined();
    expect(checkPlaywrightConfig(root)).toMatchObject({
        status: 'fail',
        fix: 'npm init playwright@latest',
    });

    await writeFile(path.join(root, 'playwright.config.mjs'), 'export default {};');
    expect(findPlaywrightConfig(root)).toBe(path.join(root, 'playwright.config.mjs'));
    expect(checkPlaywrightConfig(root).status).toBe('ok');
});

test('LLM settings: configured Azure passes, unconfigured fails naming what is missing', async () => {
    const root = await emptyDir();
    expect(checkLlmSettings(AZURE_ENV, root)).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining('fake-deployment') as unknown,
    });

    const check = checkLlmSettings({}, root);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/TESTPILOT_AZURE_OPENAI_ENDPOINT/);
    expect(check.fix).toMatch(/testpilot config set-azure-openai/);
});

test('missing Azure settings point to config set-azure-openai', async () => {
    const check = checkLlmSettings({}, await emptyDir());

    expect(check.fix).toContain('testpilot config set-azure-openai');
    expect(check.fix).toContain('--prompt-api-key');
});

test('an API key in config.json gets the remove-it fix', async () => {
    const root = await emptyDir();
    await mkdir(path.join(root, '.testpilot'));
    await writeFile(
        path.join(root, '.testpilot', 'config.json'),
        JSON.stringify({ azureOpenAI: { apiKey: 'fake-key' } }),
    );

    const check = checkLlmSettings(AZURE_ENV, root);

    expect(check.status).toBe('fail');
    expect(check.fix).toBe(
        'Remove the API key from .testpilot/config.json; set it with: ' +
            'testpilot config set-azure-openai --prompt-api-key',
    );
});

test('a bad value names the file or place to fix', async () => {
    const root = await emptyDir();
    await mkdir(path.join(root, '.testpilot'));
    await writeFile(path.join(root, '.testpilot', 'config.json'), '{ not json');
    expect(checkLlmSettings(AZURE_ENV, root).fix).toBe('Fix .testpilot/config.json');

    const other = await emptyDir();
    await writeFile(path.join(other, '.env.local'), 'TESTPILOT_MAX_TURNS=many\n');
    expect(checkLlmSettings(AZURE_ENV, other).fix).toBe('Fix the value in .env.local');

    expect(
        checkLlmSettings({ ...AZURE_ENV, TESTPILOT_MAX_TURNS: 'many' }, other).fix,
    ).toBe('Fix the value in the shell environment');
});

test('multi-line details are indented under their check', () => {
    expect(
        formatChecks([
            { name: 'LLM settings', status: 'fail', detail: 'a\nb', fix: 'f' },
        ]),
    ).toBe('✖ LLM settings: a\n    b\n    fix: f');
});

test('a broken config.json is a failed check, not a crash', async () => {
    const root = await emptyDir();
    await mkdir(path.join(root, '.testpilot'));
    await writeFile(path.join(root, '.testpilot', 'config.json'), '{ not json');

    const check = checkLlmSettings(AZURE_ENV, root);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/config\.json/);
});

test('compareVersions orders numerically', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.64.1-alpha', '1.64.1')).toBe(0);
});

test('from a project subfolder the checks look at the project root', async () => {
    const root = await emptyDir();
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, 'playwright.config.ts'), 'export default {};');
    const nested = path.join(root, 'src', 'pages');
    await mkdir(nested, { recursive: true });
    const previous = process.cwd();
    process.chdir(nested);
    try {
        const checks = await runChecks({ launchChromium: () => Promise.resolve() });
        expect(
            checks.find((check) => check.name === 'Playwright config'),
        ).toMatchObject({
            status: 'ok',
        });
    } finally {
        process.chdir(previous);
    }
});

describe('the doctor command', () => {
    let launch: MockInstance<typeof chromium.launch> | undefined;

    useIsolatedSettingsEnv();
    useCapturedOutput();

    afterEach(() => {
        launch?.mockRestore();
    });

    test('outside a Node project it exits 2 and prints each fix', async () => {
        launch = vi.spyOn(chromium, 'launch').mockResolvedValue({
            close: () => Promise.resolve(),
        } as never);

        expect(await runCli(['doctor'])).toBe(2);

        const output = stdout();
        expect(output).toContain('✖ Project Playwright');
        expect(output).toContain('npm init playwright@latest');
        expect(output).toContain('✖ LLM settings');
    });
});
