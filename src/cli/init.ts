/** `testpilot init`: set a project up for testpilot. */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import {
    CONFIG_DIR,
    CONFIG_FILE,
    type ConfigFile,
    findProjectRoot,
    readConfigObject,
    toPosix,
} from '../config.ts';
import { ConfigurationError, errorMessage } from '../runtime/exceptions.ts';
import { type Check, findPlaywrightConfig, formatChecks, runChecks } from './doctor.ts';
import { CliExit, fail } from './errors.ts';
import { installSkill, shownSkillPath, type SkillAgent, skillDir } from './skills.ts';

/** The check `init` does not stop on: the LLM is configured after `init`. */
const LLM_CHECK = 'LLM settings';

const execFileAsync = promisify(execFile);

const GITIGNORE_FILE = path.join(CONFIG_DIR, '.gitignore');

/** What testpilot writes as it runs; never committed. */
const GITIGNORE = ['logs/', 'tests/', '.playwright-mcp/'].join('\n') + '\n';

/** A spec file name no project has, so that listing it loads no spec. */
const NO_SPEC = '__testpilot_no_spec__';

/** How long Playwright may take to load the config. */
const LIST_TIMEOUT_MS = 30_000;

/** The part of Playwright's JSON report that says where the specs are. */
const ReportSchema = z.object({
    config: z.object({
        rootDir: z.string(),
        projects: z.array(z.object({ testDir: z.string() })),
    }),
});

/** Where a Playwright config runs specs from, as Playwright resolves it. */
export interface TestDirs {
    /** The config's own `testDir`, absolute; the config's folder if it sets none. */
    rootDir: string;
    /** Each project's `testDir`, absolute, in order. */
    projects: string[];
}

/**
 * Ask the project's Playwright where its config runs specs from.
 *
 * Playwright loads the config as `playwright test` would, then lists a spec
 * that does not exist, so that no spec is loaded. Its report goes to a file of
 * its own, as the config may print to stdout.
 *
 * @param cwd - The project root, where `@playwright/test` is installed.
 * @param configFile - The Playwright config.
 * @returns The folders.
 * @throws {Error} If Playwright is not installed or cannot load the config.
 */
export async function readTestDirs(cwd: string, configFile: string): Promise<TestDirs> {
    let cli: string;
    try {
        cli = createRequire(path.join(cwd, 'package.json')).resolve(
            '@playwright/test/cli',
        );
    } catch (error) {
        throw new Error('@playwright/test is not installed in this project', {
            cause: error,
        });
    }
    const folder = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
    const report = path.join(folder, 'report.json');
    // The user's own report settings would send it elsewhere.
    const env = {
        ...Object.fromEntries(
            Object.entries(process.env).filter(
                ([name]) => !name.startsWith('PLAYWRIGHT_JSON_OUTPUT_'),
            ),
        ),
        PLAYWRIGHT_JSON_OUTPUT_NAME: report,
    };
    try {
        await execFileAsync(
            process.execPath,
            [
                cli,
                'test',
                NO_SPEC,
                `--config=${configFile}`,
                '--list',
                '--pass-with-no-tests',
                '--reporter=json',
            ],
            { cwd, env, timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        );
        const { config } = ReportSchema.parse(
            JSON.parse(await readFile(report, 'utf8')),
        );
        return {
            rootDir: config.rootDir,
            projects: config.projects.map((project) => project.testDir),
        };
    } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? '';
        const reason = stderr.split('\n').find((line) => line.trim() !== '');
        throw new Error(reason?.trim() ?? errorMessage(error), { cause: error });
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
}

/**
 * Check the setup, then create `.testpilot/` with the scripts folder setting.
 *
 * Only what testpilot cannot know by itself is written: `scriptsDir`, which
 * depends on the project's Playwright `testDir`, and the `.gitignore`. An
 * existing file is never overwritten, so `init` is safe to run again; the one
 * exception is the skill folder, which `skills` replaces.
 *
 * With `skills`, the bundled skill is also installed in the project, whatever
 * the checks said: an unset project is when the agent's setup help is most
 * useful. It is installed before the checks run, so they see the new copy. With
 * `global` it is installed for the user only, and the project is neither
 * checked nor written.
 *
 * @param options - The project root and the checks to run (the working
 *   directory and the doctor checks by default), the agent to install the skill
 *   for, whether that copy is the user's, the home folder (the user's by
 *   default), and how to read the config's test folders (`readTestDirs` by
 *   default).
 * @throws {CliExit} With status 2, before writing `.testpilot/`, if a check
 *   other than the LLM settings failed, or the skill cannot be installed.
 */
export async function initCommand(
    options: {
        cwd?: string;
        checks?: () => Promise<Check[]>;
        skills?: SkillAgent;
        global?: boolean;
        home?: string;
        testDirs?: typeof readTestDirs;
    } = {},
): Promise<void> {
    const {
        cwd = findProjectRoot(),
        checks = () => runChecks({ cwd, home }),
        skills,
        global = false,
        home = homedir(),
        testDirs = readTestDirs,
    } = options;
    if (global && skills !== undefined) {
        print(await installSkillLine({ agent: skills, global }, { cwd, home }));
        return;
    }

    const lines: string[] = [];
    // Install first, so the checks do not report the copy this run replaces.
    if (skills !== undefined) {
        lines.push(await installSkillLine({ agent: skills, global }, { cwd, home }));
    }
    const results = await checks();
    print(formatChecks(results));
    const failed = results.filter((check) => check.status === 'fail');
    if (failed.some((check) => check.name !== LLM_CHECK)) {
        printAfterChecks(lines);
        throw new CliExit(2);
    }

    const scriptsDir = await scriptsDirFor(cwd, testDirs);
    await mkdir(path.join(cwd, CONFIG_DIR), { recursive: true });
    lines.push(
        ...[await writeGitignore(cwd), await writeConfig(cwd, scriptsDir)].filter(
            (line) => line !== undefined,
        ),
    );
    printAfterChecks(lines);
}

/**
 * Install the skill and say where, relative to the project or `~`.
 *
 * @throws {CliExit} With status 2, if the skill folder cannot be replaced.
 */
async function installSkillLine(
    target: { agent: SkillAgent; global: boolean },
    places: { cwd: string; home: string },
): Promise<string> {
    const destination = skillDir(target, places);
    const shown = `${shownSkillPath(target, places)}/`;
    let status: 'installed' | 'updated';
    try {
        status = await installSkill(destination);
    } catch (error) {
        fail(
            `Cannot install the skill in ${shown}: ${errorMessage(error)}. Check ` +
                'that you can write to the folder, then run the command again',
            error,
            2,
        );
    }
    return `${status} ${shown}`;
}

/** Print what init did, after the checks and set apart from them. */
function printAfterChecks(lines: string[]): void {
    if (lines.length > 0) {
        print(['', ...lines].join('\n'));
    }
}

/**
 * Where generated scripts go: a `testpilot/` folder in the folder every
 * Playwright project runs specs from, relative to the project root.
 *
 * When the projects use different folders, the scripts go to the config's own
 * `testDir`; when Playwright cannot read the config, to `testpilot/`. Either
 * way the user is told to check it.
 */
async function scriptsDirFor(
    cwd: string,
    testDirs: typeof readTestDirs,
): Promise<string> {
    const configFile = findPlaywrightConfig(cwd);
    if (configFile === undefined) {
        return 'testpilot';
    }
    const shown = path.basename(configFile);
    let dirs: TestDirs;
    try {
        dirs = await testDirs(cwd, configFile);
    } catch (error) {
        print(
            `! Could not read testDir from ${shown}: ${errorMessage(error)}; ` +
                `check scriptsDir in ${toPosix(CONFIG_FILE)}`,
        );
        return 'testpilot';
    }
    const relative = (dir: string): string => toPosix(path.relative(cwd, dir)) || '.';
    const fallback = path.posix.join(relative(dirs.rootDir), 'testpilot');
    const distinct = [...new Set(dirs.projects.map(relative))];
    const [only, ...others] = distinct;
    if (others.length === 0) {
        return only === undefined ? fallback : path.posix.join(only, 'testpilot');
    }
    print(
        `! The projects in ${shown} use different test folders ` +
            `(${distinct.join(', ')}); scripts go to ${fallback}: set scriptsDir ` +
            `in ${toPosix(CONFIG_FILE)} to the browser project's folder`,
    );
    return fallback;
}

/**
 * Write the `.gitignore` unless there is one.
 *
 * @returns The line to print, if the file was created.
 */
async function writeGitignore(cwd: string): Promise<string | undefined> {
    const file = path.join(cwd, GITIGNORE_FILE);
    if (existsSync(file)) {
        return undefined;
    }
    await writeFile(file, GITIGNORE, 'utf8');
    return `created ${toPosix(GITIGNORE_FILE)}`;
}

/**
 * Write `scriptsDir` into the config, keeping every other key and any value
 * already set.
 *
 * @returns The line to print, if the file was created or changed, or cannot be
 *   read and needs fixing by hand.
 */
async function writeConfig(
    cwd: string,
    scriptsDir: string,
): Promise<string | undefined> {
    const file = path.join(cwd, CONFIG_FILE);
    let existing: ConfigFile | undefined;
    try {
        existing = await readConfigObject(file);
    } catch (error) {
        if (error instanceof ConfigurationError) {
            return `! ${error.message}; fix it by hand`;
        }
        throw error;
    }
    if (existing?.scriptsDir !== undefined) {
        return undefined;
    }
    const config = existing ?? {};
    const status = existsSync(file) ? 'updated' : 'created';
    await writeFile(
        file,
        `${JSON.stringify({ ...config, scriptsDir }, null, 4)}\n`,
        'utf8',
    );
    return `${status} ${toPosix(CONFIG_FILE)}`;
}

function print(line: string): void {
    process.stdout.write(`${line}\n`);
}
