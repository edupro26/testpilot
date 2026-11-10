/** `testpilot init`: set a project up for testpilot. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
    CONFIG_DIR,
    CONFIG_FILE,
    type ConfigFile,
    findProjectRoot,
    readConfigObject,
} from '../config.ts';
import { ConfigurationError } from '../runtime/exceptions.ts';
import { type Check, findPlaywrightConfig, formatChecks, runChecks } from './doctor.ts';
import { CliExit } from './errors.ts';
import { installSkill, shownSkillPath, type SkillAgent, skillDir } from './skills.ts';

/** The check `init` does not stop on: the LLM is configured after `init`. */
const LLM_CHECK = 'LLM settings';

const GITIGNORE_FILE = path.join(CONFIG_DIR, '.gitignore');

/** What testpilot writes as it runs; never committed. */
const GITIGNORE = ['logs/', 'tests/', '.playwright-mcp/'].join('\n') + '\n';

// `testDir: '<path>'`, with any quote style; a template with `${` is not a literal.
const TEST_DIR = /\btestDir\s*:\s*(['"`])((?:(?!\1|\$\{).)*)\1/;

// A string, a line comment or a block comment, in the order a scan meets them, so a
// `//` inside a string (`'http://localhost'`) is part of that string.
const STRINGS_AND_COMMENTS =
    /(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * The string literal assigned to `testDir` in a Playwright config's text.
 *
 * Comments are ignored.
 *
 * @param configText - The config file's source.
 * @returns The literal, or `undefined` if there is none.
 */
export function readTestDir(configText: string): string | undefined {
    return TEST_DIR.exec(stripComments(configText))?.[2];
}

/** The text without its comments; strings are kept as they are. */
function stripComments(text: string): string {
    return text.replace(STRINGS_AND_COMMENTS, (match, quote: string | undefined) =>
        quote === undefined ? '' : match,
    );
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
 *   for, whether that copy is the user's, and the home folder (the user's by
 *   default).
 * @throws {CliExit} With status 2, before writing `.testpilot/`, if a check
 *   other than the LLM settings failed.
 */
export async function initCommand(
    options: {
        cwd?: string;
        checks?: () => Promise<Check[]>;
        skills?: SkillAgent;
        global?: boolean;
        home?: string;
    } = {},
): Promise<void> {
    const {
        cwd = findProjectRoot(),
        checks = () => runChecks({ cwd, home }),
        skills,
        global = false,
        home = homedir(),
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

    const scriptsDir = await scriptsDirFor(cwd);
    await mkdir(path.join(cwd, CONFIG_DIR), { recursive: true });
    lines.push(
        ...[await writeGitignore(cwd), await writeConfig(cwd, scriptsDir)].filter(
            (line) => line !== undefined,
        ),
    );
    printAfterChecks(lines);
}

/** Install the skill and say where, relative to the project or `~`. */
async function installSkillLine(
    target: { agent: SkillAgent; global: boolean },
    places: { cwd: string; home: string },
): Promise<string> {
    const destination = skillDir(target, places);
    const status = await installSkill(destination);
    return `${status} ${shownSkillPath(target, places)}/`;
}

/** Print what init did, after the checks and set apart from them. */
function printAfterChecks(lines: string[]): void {
    if (lines.length > 0) {
        print(['', ...lines].join('\n'));
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
        /\btestDir\b/.test(stripComments(configText))
    ) {
        print(
            `! Could not read testDir from ${path.basename(configFile)}; ` +
                `check scriptsDir in ${toPosix(CONFIG_FILE)}`,
        );
    }
    // Playwright's default testDir is the config's own folder.
    return path.posix.join(toPosix(testDir ?? '.'), 'testpilot');
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

function toPosix(file: string): string {
    return file.split(path.sep).join(path.posix.sep);
}

function print(line: string): void {
    process.stdout.write(`${line}\n`);
}
