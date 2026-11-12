/** `testpilot doctor`: check that testpilot and the project are set up. */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { findProjectRoot, loadSettings } from '../config.ts';
import { getLlmProvider } from '../llm/factory.ts';
import {
    ApiKeyInConfigError,
    ConfigurationError,
    errorMessage,
} from '../runtime/exceptions.ts';
import { CHROMIUM_ARGS } from '../validator/browser.ts';
import { CliExit } from './errors.ts';
import { checkSkills } from './skills.ts';

/** The oldest Node.js major version testpilot runs on. */
const MIN_NODE_MAJOR = 24;

/** The testpilot clone, where its own Playwright and browser are installed. */
const TESTPILOT_ROOT = path.resolve(import.meta.dirname, '..', '..');

const PLAYWRIGHT_CONFIG_NAMES = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map(
    (extension) => `playwright.config.${extension}`,
);

/** The outcome of one setup check. */
export interface Check {
    name: string;
    status: 'ok' | 'warn' | 'fail';
    detail: string;
    /** What to run or change; set on a warning or a failure. */
    fix?: string;
}

/**
 * Check the Node.js version.
 *
 * @param version - A Node.js version, e.g. `process.versions.node`.
 * @returns A failure below the minimum major version.
 */
export function checkNode(version: string): Check {
    const major = Number(version.split('.')[0]);
    return major >= MIN_NODE_MAJOR
        ? { name: 'Node.js', status: 'ok', detail: version }
        : {
              name: 'Node.js',
              status: 'fail',
              detail: `${version}, older than ${MIN_NODE_MAJOR}`,
              fix: `Install Node.js ${MIN_NODE_MAJOR} or newer`,
          };
}

/**
 * Check that testpilot's own Chromium build launches.
 *
 * @param launch - Launches and closes the browser; rejects if it cannot.
 * @returns A failure, with the install command, if the launch rejects.
 */
export async function checkChromium(launch: () => Promise<void>): Promise<Check> {
    try {
        await launch();
        return { name: 'Chromium', status: 'ok', detail: "testpilot's build launches" };
    } catch (error) {
        return {
            name: 'Chromium',
            status: 'fail',
            detail: errorMessage(error).split('\n')[0] ?? '',
            fix: `cd ${TESTPILOT_ROOT} && npx playwright install`,
        };
    }
}

/**
 * Check the project's `@playwright/test` against testpilot's own.
 *
 * @param cwd - The project root.
 * @param ownVersion - testpilot's `@playwright/test` version.
 * @returns A failure if it is not installed, a warning if it is older.
 */
export function checkProjectPlaywright(cwd: string, ownVersion: string): Check {
    const name = 'Project Playwright';
    let manifest: string;
    try {
        manifest = createRequire(path.join(cwd, 'package.json')).resolve(
            '@playwright/test/package.json',
        );
    } catch {
        // A project that declares it only needs its dependencies installed.
        return {
            name,
            status: 'fail',
            detail: '@playwright/test is not installed in this project',
            fix: declaresPlaywright(cwd) ? 'npm install' : 'npm init playwright@latest',
        };
    }
    const version = packageVersion(manifest);
    if (compareVersions(version, ownVersion) < 0) {
        return {
            name,
            status: 'warn',
            detail:
                `${version}, older than testpilot's ${ownVersion}; generated ` +
                'scripts may use newer APIs',
            fix: `npm install -D @playwright/test@${ownVersion}`,
        };
    }
    return { name, status: 'ok', detail: version };
}

/**
 * The project's Playwright config file, if it has one.
 *
 * @param cwd - The project root.
 * @returns The first `playwright.config.*` found, as a path under `cwd`.
 */
export function findPlaywrightConfig(cwd: string): string | undefined {
    return PLAYWRIGHT_CONFIG_NAMES.map((name) => path.join(cwd, name)).find((file) =>
        existsSync(file),
    );
}

/**
 * Check that the project has a Playwright config file.
 *
 * @param cwd - The project root.
 * @returns A failure if there is none.
 */
export function checkPlaywrightConfig(cwd: string): Check {
    const file = findPlaywrightConfig(cwd);
    return file === undefined
        ? {
              name: 'Playwright config',
              status: 'fail',
              detail: 'no playwright.config.* in this project',
              fix: 'npm init playwright@latest',
          }
        : { name: 'Playwright config', status: 'ok', detail: path.basename(file) };
}

/**
 * Check that the settings are valid and the LLM settings complete.
 *
 * @param env - The environment to read.
 * @param cwd - The project root.
 * @returns A failure naming what is invalid or missing: `Configuration` for an
 *   invalid file or value, `LLM settings` for missing ones or an API key in
 *   the config file.
 */
export function checkLlmSettings(env: NodeJS.ProcessEnv, cwd: string): Check {
    try {
        const settings = loadSettings(env, cwd);
        getLlmProvider(settings);
        return {
            name: 'LLM settings',
            status: 'ok',
            detail:
                `${settings.llmProvider} ` +
                `(deployment ${settings.azureDeploymentName ?? ''})`,
        };
    } catch (error) {
        if (!(error instanceof ConfigurationError)) {
            throw error;
        }
        // Missing LLM settings may be set after `init`; an invalid file or
        // value may not.
        const llm = error.source === undefined || error instanceof ApiKeyInConfigError;
        return {
            name: llm ? 'LLM settings' : 'Configuration',
            status: 'fail',
            // Without a source, the error lists the missing variables by name.
            detail:
                error.source === undefined
                    ? 'Missing required configuration variables'
                    : error.message,
            fix: llmSettingsFix(error),
        };
    }
}

/** What to change, given why the LLM settings are invalid or incomplete. */
function llmSettingsFix(error: ConfigurationError): string {
    if (error instanceof ApiKeyInConfigError) {
        return (
            'Remove the API key from .testpilot/config.json; set it with: ' +
            'testpilot config set-azure-openai --prompt-api-key'
        );
    }
    switch (error.source) {
        case undefined:
            return (
                'Run `testpilot config set-azure-openai` to set your Azure OpenAI ' +
                'settings; add `--prompt-api-key` to enter the API key'
            );
        case 'config.json':
            return 'Fix .testpilot/config.json';
        case 'environment':
            return 'Fix the value in the shell environment';
        default:
            return `Fix the value in ${error.source}`;
    }
}

/**
 * Compare two `major.minor.patch` versions numerically.
 *
 * @returns Negative if `a` is older, positive if newer, zero if equal; a
 *   prerelease suffix is ignored.
 */
export function compareVersions(a: string, b: string): number {
    const parts = (version: string): number[] =>
        (version.split('-')[0] ?? '').split('.').map(Number);
    const [left, right] = [parts(a), parts(b)];
    for (let index = 0; index < 3; index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

/**
 * Run every setup check, in order.
 *
 * @param options - The project root, environment, Chromium launcher and home
 *   folder to check; the project root found from the working directory,
 *   `process.env`, testpilot's Chromium and the user's home by default.
 * @returns One result per check.
 */
export async function runChecks(
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        launchChromium?: () => Promise<void>;
        home?: string;
    } = {},
): Promise<Check[]> {
    const {
        cwd = findProjectRoot(),
        env = process.env,
        launchChromium = launchOwnChromium,
        home = homedir(),
    } = options;
    const ownVersion = packageVersion(
        createRequire(import.meta.url).resolve('@playwright/test/package.json'),
    );
    return [
        checkNode(process.versions.node),
        await checkChromium(launchChromium),
        checkProjectPlaywright(cwd, ownVersion),
        checkPlaywrightConfig(cwd),
        checkLlmSettings(env, cwd),
        ...(await checkSkills({ cwd, home })),
    ];
}

/**
 * Render check results, one line each, with the fix under a warning or failure.
 *
 * @param checks - The results to render.
 * @returns The report, without a trailing newline.
 */
export function formatChecks(checks: Check[]): string {
    const symbols = { ok: '✔', warn: '!', fail: '✖' } as const;
    return checks
        .flatMap((check) => [
            `${symbols[check.status]} ${check.name}: ` +
                check.detail.replaceAll('\n', '\n    '),
            ...(check.fix === undefined ? [] : [`    fix: ${check.fix}`]),
        ])
        .join('\n');
}

/**
 * Print the setup checks.
 *
 * @throws {CliExit} With status 2, if any check failed; warnings pass.
 */
export async function doctorCommand(): Promise<void> {
    const checks = await runChecks();
    process.stdout.write(`${formatChecks(checks)}\n`);
    if (checks.some((check) => check.status === 'fail')) {
        throw new CliExit(2);
    }
}

/** Launch and close testpilot's own Chromium, as the pipeline launches it. */
async function launchOwnChromium(): Promise<void> {
    const browser = await chromium.launch({ args: [...CHROMIUM_ARGS] });
    await browser.close();
}

/** Whether the project's `package.json` lists `@playwright/test`. */
function declaresPlaywright(cwd: string): boolean {
    try {
        const manifest = JSON.parse(
            readFileSync(path.join(cwd, 'package.json'), 'utf8'),
        ) as { dependencies?: object; devDependencies?: object };
        return [manifest.dependencies, manifest.devDependencies].some(
            (deps) => deps !== undefined && '@playwright/test' in deps,
        );
    } catch {
        return false;
    }
}

/** The `version` field of a `package.json`. */
function packageVersion(manifest: string): string {
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        version: string;
    };
    return version;
}
