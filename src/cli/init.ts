/** `testpilot init`: set a project up for testpilot. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import {
    CONFIG_DIR,
    CONFIG_FILE,
    type ConfigFile,
    findProjectRoot,
    readConfigObject,
} from '../config.ts';
import { ConfigurationError, errorMessage } from '../runtime/exceptions.ts';
import { type Check, findPlaywrightConfig, formatChecks, runChecks } from './doctor.ts';
import { CliExit, fail } from './errors.ts';
import { installSkill, shownSkillPath, type SkillAgent, skillDir } from './skills.ts';

/** The check `init` does not stop on: the LLM is configured after `init`. */
const LLM_CHECK = 'LLM settings';

const GITIGNORE_FILE = path.join(CONFIG_DIR, '.gitignore');

/** What testpilot writes as it runs; never committed. */
const GITIGNORE = ['logs/', 'tests/', '.playwright-mcp/'].join('\n') + '\n';

/** A `testDir` as written: its literal, `null` if set some other way, else unset. */
type TestDir = string | null | undefined;

/**
 * Where a Playwright config's text sets its test folders.
 *
 * A folder set other than by one string literal (`path.join(__dirname, 'e2e')`,
 * `'./e2e' + '/smoke'`, a template with `${`) is `null`.
 */
export interface TestDirs {
    /** The config's own `testDir`, which projects without one use. */
    testDir: TestDir;
    /** Each project's `testDir`, in order; `null` for a project not written out. */
    projects: TestDir[];
}

/**
 * Read the test folders from a Playwright config's text.
 *
 * The config is the object exported by default or as `module.exports`, either
 * directly, through `defineConfig` (its only argument), under whatever name the
 * file imports it as, or through a variable declared in the file. Comments are
 * ignored.
 *
 * @param configText - The config file's source.
 * @returns The folders; a `testDir` of `null` if the config object cannot be
 *   found, as nothing can then be said of where its specs are.
 */
export function readTestDirs(configText: string): TestDirs {
    const source = ts.createSourceFile(
        'playwright.config.ts',
        configText,
        ts.ScriptTarget.Latest,
        true,
    );
    const config = configObject(source);
    if (config === undefined) {
        return { testDir: null, projects: [] };
    }
    const projects = propertyValue(config, 'projects');
    return {
        testDir: literal(propertyValue(config, 'testDir')),
        projects:
            projects === undefined
                ? []
                : ts.isArrayLiteralExpression(projects)
                  ? projects.elements.map((project) =>
                        ts.isObjectLiteralExpression(project)
                            ? literal(propertyValue(project, 'testDir'))
                            : null,
                    )
                  : [null],
    };
}

/** The config object a Playwright config file exports, if it can be found. */
function configObject(source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
    for (const node of source.statements) {
        if (ts.isExportAssignment(node)) {
            return objectOf(node.expression, source);
        }
        if (
            ts.isExpressionStatement(node) &&
            ts.isBinaryExpression(node.expression) &&
            node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            node.expression.left.getText() === 'module.exports'
        ) {
            return objectOf(node.expression.right, source);
        }
    }
    return undefined;
}

/**
 * The object literal an expression stands for: itself, the only argument of
 * `defineConfig`, or the value of a variable declared at the top of `source`.
 * `defineConfig` given several configs merges them, so none of them alone is
 * the config.
 */
function objectOf(
    expression: ts.Expression,
    source: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined {
    while (
        ts.isParenthesizedExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isAsExpression(expression)
    ) {
        expression = expression.expression;
    }
    if (ts.isObjectLiteralExpression(expression)) {
        return expression;
    }
    if (
        ts.isCallExpression(expression) &&
        isDefineConfig(expression.expression, source)
    ) {
        const [only, ...others] = expression.arguments;
        return only === undefined || others.length > 0
            ? undefined
            : objectOf(only, source);
    }
    if (ts.isIdentifier(expression)) {
        const declaration = source.statements
            .filter(ts.isVariableStatement)
            .flatMap((statement) => statement.declarationList.declarations)
            .find((d) => ts.isIdentifier(d.name) && d.name.text === expression.text);
        return declaration?.initializer === undefined
            ? undefined
            : objectOf(declaration.initializer, source);
    }
    return undefined;
}

/**
 * Whether `callee` is Playwright's `defineConfig`: by that name, as a property
 * (`test.defineConfig`), or by the name the file imports or requires it as
 * (`import { defineConfig as config }`, `const { defineConfig: config } =
 * require(...)`).
 */
function isDefineConfig(callee: ts.Expression, source: ts.SourceFile): boolean {
    if (ts.isPropertyAccessExpression(callee)) {
        return callee.name.text === 'defineConfig';
    }
    if (!ts.isIdentifier(callee)) {
        return false;
    }
    if (callee.text === 'defineConfig') {
        return true;
    }
    for (const statement of source.statements) {
        const bindings = ts.isImportDeclaration(statement)
            ? statement.importClause?.namedBindings
            : undefined;
        if (
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.some(
                (element) =>
                    element.name.text === callee.text &&
                    element.propertyName?.getText() === 'defineConfig',
            )
        ) {
            return true;
        }
        if (
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (declaration) =>
                    ts.isObjectBindingPattern(declaration.name) &&
                    declaration.name.elements.some(
                        (element) =>
                            ts.isIdentifier(element.name) &&
                            element.name.text === callee.text &&
                            element.propertyName?.getText() === 'defineConfig',
                    ),
            )
        ) {
            return true;
        }
    }
    return false;
}

/**
 * What an object literal sets `name` to: the last value given, as at run time,
 * or the property itself when it is shorthand (`{ testDir }`) or spread over.
 */
function propertyValue(
    object: ts.ObjectLiteralExpression,
    name: string,
): ts.Node | undefined {
    let value: ts.Node | undefined;
    for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
            value = property;
        } else if (
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            property.name.text === name
        ) {
            value = ts.isPropertyAssignment(property) ? property.initializer : property;
        }
    }
    return value;
}

/** A value as a `TestDir`: the text of a plain string literal, else `null`. */
function literal(value: ts.Node | undefined): TestDir {
    if (value === undefined) {
        return undefined;
    }
    return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
        ? value.text
        : null;
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
 *   other than the LLM settings failed, or the skill cannot be installed.
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
 * Playwright project runs specs from.
 *
 * When the projects use different folders, or one cannot be read, the scripts
 * go to the config's own `testDir`, and the user is told to check it.
 */
async function scriptsDirFor(cwd: string): Promise<string> {
    const configFile = findPlaywrightConfig(cwd);
    const dirs: TestDirs =
        configFile === undefined
            ? { testDir: undefined, projects: [] }
            : readTestDirs(await readFile(configFile, 'utf8'));
    // Playwright's default testDir is the config's own folder.
    const fallback = path.posix.join(toPosix(dirs.testDir ?? '.'), 'testpilot');
    const inherited = dirs.testDir === undefined ? '.' : dirs.testDir;
    const folders =
        dirs.projects.length === 0
            ? [inherited]
            : dirs.projects.map((dir) => (dir === undefined ? inherited : dir));
    const readable = folders.filter((dir) => dir !== null);
    const shown = path.basename(configFile ?? '');
    if (readable.length < folders.length) {
        print(
            `! Could not read testDir from ${shown}; ` +
                `check scriptsDir in ${toPosix(CONFIG_FILE)}`,
        );
        return fallback;
    }
    const distinct = [
        ...new Set(readable.map((dir) => path.posix.normalize(toPosix(dir)))),
    ];
    const [only, ...others] = distinct;
    if (only !== undefined && others.length === 0) {
        return path.posix.join(only, 'testpilot');
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

function toPosix(file: string): string {
    return file.split(path.sep).join(path.posix.sep);
}

function print(line: string): void {
    process.stdout.write(`${line}\n`);
}
