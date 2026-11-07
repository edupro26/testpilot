/** `testpilot init`: set a project up for testpilot. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_DIR, CONFIG_FILE, type ConfigFile } from '../config.ts';
import { type Check, findPlaywrightConfig, formatChecks, runChecks } from './doctor.ts';
import { CliExit } from './errors.ts';

/** The check `init` does not stop on: the LLM is configured after `init`. */
const LLM_CHECK = 'LLM settings';

const GITIGNORE_FILE = path.join(CONFIG_DIR, '.gitignore');

/** What testpilot writes as it runs; never committed. */
const GITIGNORE = ['logs/', 'tests/', '.playwright-mcp/'].join('\n') + '\n';

// `testDir: '<path>'`, with any quote style; a template with `${` is not a literal.
const TEST_DIR = /\btestDir\s*:\s*(['"`])((?:(?!\1|\$\{).)*)\1/;

/**
 * The string literal assigned to `testDir` in a Playwright config's text.
 *
 * @param configText - The config file's source.
 * @returns The literal, or `undefined` if there is none.
 */
export function readTestDir(configText: string): string | undefined {
    return TEST_DIR.exec(configText)?.[2];
}

/**
 * Check the setup, then create `.testpilot/` with the scripts folder setting.
 *
 * Only what testpilot cannot know by itself is written: `scriptsDir`, which
 * depends on the project's Playwright `testDir`, and the `.gitignore`. An
 * existing file is never overwritten, so `init` is safe to run again.
 *
 * @param options - The project root and the checks to run; the working
 *   directory and the doctor checks by default.
 * @throws {CliExit} With status 2, before writing anything, if a check other
 *   than the LLM settings failed.
 */
export async function initCommand(
    options: { cwd?: string; checks?: () => Promise<Check[]> } = {},
): Promise<void> {
    const { cwd = process.cwd(), checks = () => runChecks({ cwd }) } = options;
    const results = await checks();
    print(formatChecks(results));
    const failed = results.filter((check) => check.status === 'fail');
    if (failed.some((check) => check.name !== LLM_CHECK)) {
        throw new CliExit(2);
    }

    const scriptsDir = await scriptsDirFor(cwd);
    await mkdir(path.join(cwd, CONFIG_DIR), { recursive: true });
    print('');
    print(`${await writeGitignore(cwd)} ${toPosix(GITIGNORE_FILE)}`);
    const [status, note = ''] = await writeConfig(cwd, scriptsDir);
    print(`${status} ${toPosix(CONFIG_FILE)}${note}`);
    if (failed.length > 0) {
        print(
            '\nNext: add your Azure OpenAI settings to .testpilot/config.json and ' +
                'set TESTPILOT_AZURE_OPENAI_API_KEY.',
        );
    }
}

/** Where generated scripts go: a `testpilot/` folder in the project's testDir. */
async function scriptsDirFor(cwd: string): Promise<string> {
    const configFile = findPlaywrightConfig(cwd);
    const configText =
        configFile === undefined ? '' : await readFile(configFile, 'utf8');
    const testDir = readTestDir(configText);
    if (
        testDir === undefined &&
        configFile !== undefined &&
        /\btestDir\b/.test(configText)
    ) {
        print(
            `! Could not read testDir from ${path.basename(configFile)}; ` +
                `check scriptsDir in ${toPosix(CONFIG_FILE)}`,
        );
    }
    // Playwright's default testDir is the config's own folder.
    return path.posix.join(toPosix(testDir ?? '.'), 'testpilot');
}

/** Write the `.gitignore` unless there is one. */
async function writeGitignore(cwd: string): Promise<string> {
    const file = path.join(cwd, GITIGNORE_FILE);
    if (existsSync(file)) {
        return 'kept';
    }
    await writeFile(file, GITIGNORE, 'utf8');
    return 'created';
}

/**
 * Write `scriptsDir` into the config, keeping every other key and any value
 * already set.
 *
 * @returns What happened to the file, and a note to print after its name.
 */
async function writeConfig(
    cwd: string,
    scriptsDir: string,
): Promise<[status: string, note?: string]> {
    const file = path.join(cwd, CONFIG_FILE);
    let config: ConfigFile = {};
    if (existsSync(file)) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readFile(file, 'utf8'));
        } catch {
            return ['kept', ' (not valid JSON; fix it by hand)'];
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return ['kept', ' (not a JSON object; fix it by hand)'];
        }
        config = parsed;
        if (config.scriptsDir !== undefined) {
            return ['kept'];
        }
    }
    const status = existsSync(file) ? 'updated' : 'created';
    await writeFile(
        file,
        `${JSON.stringify({ ...config, scriptsDir }, null, 4)}\n`,
        'utf8',
    );
    return [status];
}

function toPosix(file: string): string {
    return file.split(path.sep).join(path.posix.sep);
}

function print(line: string): void {
    process.stdout.write(`${line}\n`);
}
