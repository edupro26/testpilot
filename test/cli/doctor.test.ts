/** Tests for the doctor command: each setup check and its fix. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { runCli } from '../../src/cli/cli.ts';
import {
    checkChromium,
    checkLlmSettings,
    checkNode,
    checkPlaywrightConfig,
    checkProjectPlaywright,
    compareVersions,
    findPlaywrightConfig,
} from '../../src/cli/doctor.ts';
import { useIsolatedSettingsEnv } from '../helpers.ts';

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
    expect(check.fix).toMatch(/TESTPILOT_AZURE_OPENAI_API_KEY/);
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

describe('the doctor command', () => {
    useIsolatedSettingsEnv();

    test('outside a Node project it exits 2 and prints each fix', async () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

        expect(await runCli(['doctor'])).toBe(2);

        const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(output).toContain('✖ Project Playwright');
        expect(output).toContain('npm init playwright@latest');
        expect(output).toContain('✖ LLM settings');
    });
});
