/** `testpilot config`: inspect and change the settings testpilot resolves. */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { InvalidArgumentError } from 'commander';

import {
    API_KEY_VARIABLE,
    CONFIG_FILE,
    findProjectRoot,
    type LoadedSettings,
    readConfigObject,
    resolveSettings,
    SETTINGS,
    type SettingSource,
    type SettingVariable,
} from '../config.ts';
import { logger } from '../logger.ts';
import { ConfigurationError, errorMessage } from '../runtime/exceptions.ts';
import { CliExit, fail } from './errors.ts';

/** The Azure OpenAI options, the `config.json` key each sets and its variable. */
const AZURE_VALUES = [
    {
        option: 'endpoint',
        key: 'endpoint',
        variable: 'TESTPILOT_AZURE_OPENAI_ENDPOINT',
    },
    { option: 'modelName', key: 'modelName', variable: 'TESTPILOT_AZURE_MODEL_NAME' },
    {
        option: 'deploymentName',
        key: 'deploymentName',
        variable: 'TESTPILOT_AZURE_DEPLOYMENT_NAME',
    },
    {
        option: 'apiVersion',
        key: 'apiVersion',
        variable: 'TESTPILOT_OPENAI_API_VERSION',
    },
] as const;

/** Where `--save` writes without a path, relative to the project root. */
const DEFAULT_DOTENV = '.env.local';

const SAVE_TARGET = /^dotenv(?::(.+))?$/;

/**
 * Hide all but the end of a secret.
 *
 * @param value - The secret.
 * @returns `****` and its last 4 characters; just `****` for 8 or fewer.
 */
export function maskSecret(value: string): string {
    return value.length <= 8 ? '****' : `****${value.slice(-4)}`;
}

/**
 * Render each setting on a line: its name, its effective value and, in
 * parentheses, where the value came from.
 *
 * The name is the `config.json` key, or the variable for the API key, which
 * `config.json` never holds. The API key is masked; a setting with no value
 * reads `(not set)`.
 *
 * @param loaded - The settings and the source of each value.
 * @returns One line per setting, in the order of `SETTINGS`.
 */
export function formatSettings(loaded: LoadedSettings): string {
    const rows = SETTINGS.map(({ variable, configKey, field, secret }) => {
        const value = loaded.settings[field];
        const source = loaded.sources[variable];
        return {
            name: configKey ?? variable,
            value:
                value === undefined
                    ? '(not set)'
                    : secret
                      ? maskSecret(String(value))
                      : String(value),
            source: value === undefined || source === undefined ? '' : `(${source})`,
        };
    });
    const nameWidth = Math.max(...rows.map(({ name }) => name.length));
    const valueWidth = Math.max(...rows.map(({ value }) => value.length));
    return rows
        .map(({ name, value, source }) =>
            [name.padEnd(nameWidth), value.padEnd(valueWidth), source]
                .join('  ')
                .trimEnd(),
        )
        .join('\n');
}

/**
 * `testpilot config list`: print every effective setting and its source.
 *
 * @param options - Where to read from; the process environment and the
 *   current project by default.
 * @throws {CliExit} With status 2, if the configuration is invalid.
 */
export function configListCommand(
    options: { env?: NodeJS.ProcessEnv; root?: string } = {},
): void {
    let loaded: LoadedSettings;
    try {
        loaded = resolveSettings(options.env, options.root);
    } catch (error) {
        if (error instanceof ConfigurationError) {
            logger.error(`Invalid configuration: ${error.message}`);
            throw new CliExit(2, { cause: error });
        }
        throw error;
    }
    process.stdout.write(`${formatSettings(loaded)}\n`);
}

/**
 * Parse the `--save` option's argument.
 *
 * @param value - `dotenv` or `dotenv:<path>`.
 * @returns The path, or `''` for the default dotenv file.
 * @throws {InvalidArgumentError} If `value` is neither form.
 */
export function parseSave(value: string): string {
    const match = SAVE_TARGET.exec(value);
    if (match === null) {
        throw new InvalidArgumentError('expected dotenv or dotenv:<path>');
    }
    return match[1] ?? '';
}

/**
 * Set variables in a dotenv file's text.
 *
 * An existing `KEY=` assignment (optionally `export KEY=`, optionally indented)
 * is replaced in place, a quoted value that spans lines included. So is every
 * assignment whose key differs only in case, since settings are read whatever
 * the case of their name; the key is spelled as in `values`. Keys that are
 * missing are appended. A line inside another variable's quoted value is part
 * of that value, never an assignment. Everything else is kept byte for byte,
 * and the file's line ending is kept.
 *
 * @param text - The file's current content; empty if there is none.
 * @param values - The variables to set.
 * @returns The new content.
 * @throws {ConfigurationError} If a value cannot be written so that it reads back
 *   unchanged: it has a newline, or both kinds of quote. The message names the
 *   variable, never the value.
 */
export function updateDotenv(text: string, values: Record<string, string>): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    // By the name in capitals: settings are read whatever the case of the name.
    const lines = new Map(
        Object.entries(values).map(([key, value]) => [
            key.toUpperCase(),
            `${key}=${quote(key, value)}`,
        ]),
    );
    const replaced = new Set<string>();
    let result = '';
    let kept = 0;
    for (const { lead, key, start, end } of dotenvAssignments(text)) {
        const line = lines.get(key.toUpperCase());
        if (line !== undefined) {
            result += `${text.slice(kept, start)}${lead}${line}`;
            kept = end;
            replaced.add(key.toUpperCase());
        }
    }
    result += text.slice(kept);
    const missing = [...lines].filter(([key]) => !replaced.has(key));
    if (missing.length === 0) {
        return result;
    }
    const separator = result === '' || result.endsWith('\n') ? '' : eol;
    return `${result}${separator}${missing.map(([, line]) => line).join(eol)}${eol}`;
}

// The start of an assignment: indent and `export `, the key, and `=` with the
// blanks around it. A line that starts with `#` is a comment.
const ASSIGNMENT = /^([ \t]*(?:export[ \t]+)?)([^\s#=][^=\r\n]*?)[ \t]*=[ \t]*/;

/** One assignment in a dotenv file's text. */
interface DotenvAssignment {
    /** The indent and `export ` before the key. */
    lead: string;
    key: string;
    /** Where the assignment starts: the start of its line. */
    start: number;
    /** Where it ends: the end of the line its value ends on, before the line break. */
    end: number;
}

/**
 * Every assignment in a dotenv file's text, as `node:util`'s `parseEnv` reads
 * them: a value that opens a quote closed on a later line runs to the end of
 * that line, so the lines in between are not assignments.
 */
function dotenvAssignments(text: string): DotenvAssignment[] {
    const found: DotenvAssignment[] = [];
    for (let start = 0; start < text.length;) {
        let end = lineEnd(text, start);
        const match = ASSIGNMENT.exec(text.slice(start, end));
        if (match !== null) {
            const [prefix, lead = '', key = ''] = match;
            const valueStart = start + prefix.length;
            const opening = text[valueStart];
            if (opening === '"' || opening === "'" || opening === '`') {
                const closing = text.indexOf(opening, valueStart + 1);
                if (closing !== -1) {
                    end = lineEnd(text, closing);
                }
            }
            found.push({ lead, key, start, end });
        }
        const newline = text.indexOf('\n', end);
        start = newline === -1 ? text.length : newline + 1;
    }
    return found;
}

/** The end of the line `index` is on, before its `\n` or `\r\n`. */
function lineEnd(text: string, index: number): number {
    const newline = text.indexOf('\n', index);
    if (newline === -1) {
        return text.length;
    }
    return newline > index && text[newline - 1] === '\r' ? newline - 1 : newline;
}

/**
 * A value as `node:util`'s `parseEnv` reads it back unchanged.
 *
 * Double quotes would expand a `\n` and cannot hold a `"`, and single quotes
 * are read literally, so the first of the two that fits is used.
 */
function quote(key: string, value: string): string {
    const needsSingle = value.includes('"') || value.includes('\\n');
    if (/[\r\n]/.test(value) || (needsSingle && value.includes("'"))) {
        throw new ConfigurationError(
            `${key}: the value cannot be written to a dotenv file so that it reads ` +
                'back unchanged (a newline, or a single quote next to a double ' +
                'quote or a backslash and n); set it in the shell instead',
        );
    }
    if (!/[\s#"'`]/.test(value)) {
        return value;
    }
    return needsSingle ? `'${value}'` : `"${value}"`;
}

/** What `config set-azure-openai` was given. */
export interface SetAzureOptions {
    endpoint?: string;
    modelName?: string;
    deploymentName?: string;
    apiVersion?: string;
    /** Ask for the API key with hidden input. */
    promptApiKey?: boolean;
    /** The dotenv file to write to: `''` for the default, else a path. */
    save?: string;
}

/** What `config set-azure-openai` depends on; each has a real default. */
export interface SetAzureDeps {
    /** The project root; the nearest folder with a `package.json`. */
    root?: string;
    /** What a `--save` path and the printed paths are relative to. */
    cwd?: string;
    /** Whether a person can type an answer; whether stdin is a terminal. */
    isInteractive?: () => boolean;
    /** Ask for a secret without echoing it. */
    readSecret?: (prompt: string) => Promise<string>;
}

/**
 * Write the Azure OpenAI settings.
 *
 * The given values are merged into `.testpilot/config.json` (which also gets
 * `llmProvider: azure_openai`). With `--save` they are written to a dotenv file
 * as well. With `--prompt-api-key` the API key is read with hidden input and
 * written to that dotenv file, `.env.local` by default, and nowhere else; the
 * file is made readable by its owner only before the key goes in, whether it is
 * new or not. A value of the key is never printed.
 *
 * The dotenv file is written before `config.json`. Afterwards the settings are
 * resolved again, and a warning on standard error names each variable written
 * that a stronger source still overrides, and a dotenv file testpilot does not
 * read; the exit status stays 0.
 *
 * @param options - The values to set and where to save them.
 * @param deps - The project and terminal; the real ones by default.
 * @throws {CliExit} With status 2, before writing anything, if there is
 *   nothing to set, the key cannot be asked for, none was entered, or
 *   `config.json` cannot be read.
 */
export async function configSetAzureOpenAICommand(
    options: SetAzureOptions,
    deps: SetAzureDeps = {},
): Promise<void> {
    const {
        root = findProjectRoot(),
        cwd = process.cwd(),
        isInteractive = () => process.stdin.isTTY,
        readSecret = readHiddenInput,
    } = deps;
    const given = AZURE_VALUES.flatMap(({ option, key, variable }) => {
        const value = options[option];
        return value === undefined ? [] : [{ key, variable, value }];
    });
    const { promptApiKey = false, save } = options;
    if (given.length === 0 && !promptApiKey) {
        logger.error(
            'Nothing to set: give at least one of --endpoint, --model-name, ' +
                '--deployment-name, --api-version or --prompt-api-key',
        );
        throw new CliExit(2);
    }
    if (promptApiKey && !isInteractive()) {
        logger.error(
            '--prompt-api-key needs an interactive terminal; run this command in ' +
                'your own terminal',
        );
        throw new CliExit(2);
    }

    const configFile = path.join(root, CONFIG_FILE);
    let config: Record<string, unknown> = {};
    if (given.length > 0) {
        try {
            config = (await readConfigObject(configFile)) ?? {};
        } catch (error) {
            if (error instanceof ConfigurationError) {
                fail(error.message, error, 2);
            }
            throw error;
        }
    }
    const azure: unknown = config.azureOpenAI ?? {};
    if (typeof azure !== 'object' || Array.isArray(azure)) {
        logger.error(`${CONFIG_FILE}: azureOpenAI is not an object; fix it by hand`);
        throw new CliExit(2);
    }

    // Asked for before anything is written, so an empty answer leaves no trace.
    let apiKey: string | undefined;
    if (promptApiKey) {
        apiKey = (await readSecret('Azure OpenAI API key (input is hidden): ')).trim();
        if (apiKey === '') {
            logger.error('No API key entered; nothing was written');
            throw new CliExit(2);
        }
    }

    // Everything is read and computed before anything is written, so a failure
    // leaves no half-done run. The dotenv file is written first: if it cannot be
    // written, config.json is left as it was.
    const writes: Write[] = [];
    const variables: Record<string, string> = {};
    if (save !== undefined) {
        for (const { variable, value } of given) {
            variables[variable] = value;
        }
    }
    if (apiKey !== undefined) {
        variables[API_KEY_VARIABLE] = apiKey;
    }
    if (Object.keys(variables).length > 0) {
        const dotenv =
            save === undefined || save === ''
                ? path.join(root, DEFAULT_DOTENV)
                : path.resolve(cwd, save);
        try {
            const current = await readIfExists(dotenv);
            writes.push({
                file: dotenv,
                text: updateDotenv(current, variables),
                note: ` (${Object.keys(variables).join(', ')})`,
                private: true,
                holdsKey: apiKey !== undefined,
                source: dotenvSource(root, dotenv),
                variables: Object.keys(variables),
            });
        } catch (error) {
            fail(failure(cwd, dotenv, error), error, 2);
        }
    }
    if (given.length > 0) {
        const merged = {
            ...config,
            llmProvider: 'azure_openai',
            azureOpenAI: {
                ...azure,
                ...Object.fromEntries(given.map(({ key, value }) => [key, value])),
            },
        };
        writes.push({
            file: configFile,
            text: `${JSON.stringify(merged, null, 4)}\n`,
            note: '',
            source: 'config.json',
            variables: given.map(({ variable }) => variable),
        });
    }

    for (const { file, text, note, private: isPrivate, holdsKey } of writes) {
        if (holdsKey === true) {
            try {
                await restrictToOwner(file);
            } catch (error) {
                fail(
                    `${display(cwd, file)}: cannot make it readable by its owner ` +
                        `only, so the API key was not written: ${errorMessage(error)}`,
                    error,
                    2,
                );
            }
        }
        try {
            await mkdir(path.dirname(file), { recursive: true });
            // The mode only applies on creation; an existing file holding the key
            // was restricted above.
            await writeFile(file, text, {
                encoding: 'utf8',
                ...(isPrivate === true ? { mode: 0o600 } : {}),
            });
        } catch (error) {
            fail(failure(cwd, file, error), error, 2);
        }
        print(`updated ${display(cwd, file)}${note}`);
    }
    warnIfOverridden(root, writes);
}

/** A file `config set-azure-openai` writes, and the variables it sets there. */
interface Write {
    file: string;
    text: string;
    /** Printed after the file's name. */
    note: string;
    /** Whether the file may hold the key, so is created readable by its owner only. */
    private?: boolean;
    /**
     * Whether the key is written: an existing file is first restricted to its
     * owner.
     */
    holdsKey?: boolean;
    /** The settings source the file is; `undefined` for one testpilot never reads. */
    source: SettingSource | undefined;
    variables: string[];
}

/** The settings source `file` is: `.env` or `.env.local` at the project root. */
function dotenvSource(root: string, file: string): SettingSource | undefined {
    if (file === path.join(root, '.env')) {
        return '.env';
    }
    return file === path.join(root, DEFAULT_DOTENV) ? '.env.local' : undefined;
}

/** A settings source as the developer knows it. */
function describeSource(source: SettingSource): string {
    switch (source) {
        case 'config.json':
            return display('.', CONFIG_FILE);
        case 'environment':
            return 'the environment';
        default:
            return source;
    }
}

/**
 * Warn about each value just written that does not take effect: a stronger
 * source still sets it, or it went to a file testpilot never reads. Names the
 * variables and the files, never a value.
 */
function warnIfOverridden(root: string, writes: Write[]): void {
    // Each variable's strongest written source wins; the dotenv file is first.
    const written = new Map<string, SettingSource>();
    for (const { file, source, variables } of writes) {
        if (source === undefined) {
            logger.warning(
                `testpilot does not read ${display(root, file)} (only .env and ` +
                    '.env.local at the project root); load it into the environment ' +
                    'yourself',
            );
            continue;
        }
        for (const variable of variables) {
            if (!written.has(variable)) {
                written.set(variable, source);
            }
        }
    }
    if (written.size === 0) {
        return;
    }
    let loaded: LoadedSettings;
    try {
        loaded = resolveSettings(process.env, root);
    } catch (error) {
        logger.warning(
            `Cannot check that the values take effect: ${errorMessage(error)}`,
        );
        return;
    }
    for (const [variable, source] of written) {
        const effective = loaded.sources[variable as SettingVariable];
        if (effective !== undefined && effective !== source) {
            logger.warning(
                `${variable} is still taken from ${describeSource(effective)}, which ` +
                    `overrides ${describeSource(source)}`,
            );
        }
    }
}

/** Make `file` readable and writable by its owner only, if it exists. */
async function restrictToOwner(file: string): Promise<void> {
    try {
        await chmod(file, 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

/** The file's text; empty if it does not exist. */
async function readIfExists(file: string): Promise<string> {
    try {
        return await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
        }
        throw error;
    }
}

/** Why `file` could not be read or written, naming it. */
function failure(cwd: string, file: string, error: unknown): string {
    return `${display(cwd, file)}: ${errorMessage(error)}`;
}

/**
 * Read a line from a terminal without echoing it.
 *
 * Puts `input` in raw mode until Enter, Ctrl+C or the end of the stream, and
 * restores it on each of them. Backspace deletes; arrow keys and other escape
 * sequences are ignored.
 *
 * @param prompt - What to ask; written to `output`.
 * @param input - The terminal to read; standard input by default.
 * @param output - Where the prompt goes; standard error by default.
 * @returns What was typed, without the line ending.
 * @throws {CliExit} With status 2, on Ctrl+C.
 */
export function readHiddenInput(
    prompt: string,
    input: NodeJS.ReadStream = process.stdin,
    output: { write: (text: string) => unknown } = process.stderr,
): Promise<string> {
    return new Promise((resolve, reject) => {
        let value = '';
        const finish = (settle: () => void): void => {
            input.off('data', onData);
            input.off('end', onEnd);
            input.off('error', onError);
            input.setRawMode(false);
            input.pause();
            output.write('\n');
            settle();
        };
        const onData = (chunk: string): void => {
            const chars = Array.from(chunk);
            for (let i = 0; i < chars.length; i++) {
                const char = chars[i] ?? '';
                if (char === '\r' || char === '\n' || char === '\u0004') {
                    finish(() => {
                        resolve(value);
                    });
                    return;
                }
                if (char === '\u0003') {
                    finish(() => {
                        logger.error('Cancelled');
                        reject(new CliExit(2));
                    });
                    return;
                }
                if (char === '\u001b') {
                    i = endOfEscape(chars, i);
                } else if (char === '\u007f' || char === '\b') {
                    value = Array.from(value).slice(0, -1).join('');
                } else if (char >= ' ') {
                    value += char;
                }
            }
        };
        const onEnd = (): void => {
            finish(() => {
                resolve(value);
            });
        };
        const onError = (error: Error): void => {
            finish(() => {
                reject(error);
            });
        };

        output.write(prompt);
        input.setEncoding('utf8');
        input.setRawMode(true);
        input.on('data', onData);
        input.on('end', onEnd);
        input.on('error', onError);
        input.resume();
    });
}

/**
 * The index of the last character of the escape sequence that starts at `start`.
 *
 * `ESC [` (CSI) runs to its final byte (`@` to `~`), `ESC O` (SS3) takes one
 * more character, and `ESC` and one character is an Alt key. A sequence cut off
 * by the end of the chunk ends there.
 */
function endOfEscape(chars: string[], start: number): number {
    const kind = chars[start + 1];
    if (kind === 'O') {
        return Math.min(start + 2, chars.length - 1);
    }
    if (kind !== '[') {
        return Math.min(start + 1, chars.length - 1);
    }
    let end = start + 2;
    while (end < chars.length - 1 && !/[@-~]/.test(chars[end] ?? '')) {
        end++;
    }
    return end;
}

/** `file` as shown to the developer: relative to `cwd`, with `/` separators. */
function display(cwd: string, file: string): string {
    return path.relative(cwd, file).split(path.sep).join(path.posix.sep);
}

function print(line: string): void {
    process.stdout.write(`${line}\n`);
}
