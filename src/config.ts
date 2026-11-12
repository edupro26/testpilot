/** Application settings and logging configuration. */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { z } from 'zod';

import { LOG_LEVELS, type LogLevel, setLogLevel } from './logger.ts';
import {
    ApiKeyInConfigError,
    ConfigurationError,
    errorMessage,
} from './runtime/exceptions.ts';

/** Supported values for the llmProvider setting. */
export const LLM_PROVIDER_NAMES = ['azure_openai'] as const;

export type LLMProviderName = (typeof LLM_PROVIDER_NAMES)[number];

/** The project folder testpilot keeps its files in. */
export const CONFIG_DIR = '.testpilot';

/** The project's settings file, relative to the project root. */
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** The environment variable that holds the API key, which `config.json` never does. */
export const API_KEY_VARIABLE = 'TESTPILOT_AZURE_OPENAI_API_KEY';

/** A key named like an API key, whatever its spelling or depth. */
const API_KEY_NAME = /api[_-]?key/i;

const LogLevelSchema = z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(LOG_LEVELS));

/** Whether `value` is a BCP 47 language tag, as the browser's locale must be. */
function isLocale(value: string): boolean {
    try {
        return Intl.getCanonicalLocales(value).length === 1;
    } catch {
        return false;
    }
}

const ConfigFileSchema = z.strictObject({
    llmProvider: z.enum(LLM_PROVIDER_NAMES).optional(),
    azureOpenAI: z
        .strictObject({
            endpoint: z.string().optional(),
            modelName: z.string().optional(),
            deploymentName: z.string().optional(),
            apiVersion: z.string().optional(),
        })
        .optional(),
    scriptsDir: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    locale: z.string().optional(),
    logLevel: LogLevelSchema.optional(),
});

/** The contents of `.testpilot/config.json`; every key is optional. */
export type ConfigFile = z.input<typeof ConfigFileSchema>;

const SettingsSchema = z.object({
    TESTPILOT_LLM_PROVIDER: z.enum(LLM_PROVIDER_NAMES).default('azure_openai'),

    TESTPILOT_AZURE_OPENAI_ENDPOINT: z.string().optional(),
    TESTPILOT_AZURE_OPENAI_API_KEY: z.string().optional(),
    TESTPILOT_AZURE_DEPLOYMENT_NAME: z.string().optional(),
    TESTPILOT_AZURE_MODEL_NAME: z.string().optional(),
    TESTPILOT_OPENAI_API_VERSION: z.string().optional(),

    // Where generated specs are written; inside the project's Playwright testDir.
    TESTPILOT_SCRIPTS_DIR: z.string().min(1).default('testpilot'),

    // Shared by the MCP browser, the validation browser and the generated script,
    // since sites localise by Accept-Language.
    TESTPILOT_LOCALE: z
        .string()
        .refine(isLocale, 'must be a language tag, such as en-US or pt-PT')
        .default('en-US'),

    TESTPILOT_MAX_TURNS: z.coerce.number().int().positive().default(25),

    TESTPILOT_LOG_LEVEL: LogLevelSchema.default('INFO'),
});

/** Typed application settings, from the project's config file and environment. */
export interface Settings {
    llmProvider: LLMProviderName;
    azureOpenaiEndpoint: string | undefined;
    azureOpenaiApiKey: string | undefined;
    azureDeploymentName: string | undefined;
    azureModelName: string | undefined;
    openaiApiVersion: string | undefined;
    scriptsDir: string;
    browserLocale: string;
    mcpMaxTurns: number;
    logLevel: LogLevel;
}

/** The name of a setting's `TESTPILOT_` environment variable. */
export type SettingVariable = keyof typeof SettingsSchema.shape;

/** Where a setting's value came from, in order of precedence, weakest first. */
export type SettingSource =
    'default' | 'config.json' | '.env' | '.env.local' | 'environment' | 'flag';

/** Command flag values by the setting they override, as typed. */
export type SettingFlags = Partial<Record<SettingVariable, string>>;

/** One setting: its variable, its `config.json` key and its `Settings` field. */
export interface SettingSpec {
    variable: SettingVariable;
    /** The dotted `config.json` path, e.g. `azureOpenAI.endpoint`; none for the key. */
    configKey: string | undefined;
    field: keyof Settings;
    /** Whether the value must never be shown; only the API key. */
    secret: boolean;
    /** The `generate` flag that overrides it for a run; none for most settings. */
    flag: string | undefined;
}

/** Every setting, in the order the documentation lists them. */
export const SETTINGS: readonly SettingSpec[] = [
    {
        variable: 'TESTPILOT_LLM_PROVIDER',
        configKey: 'llmProvider',
        field: 'llmProvider',
        secret: false,
        flag: undefined,
    },
    {
        variable: 'TESTPILOT_AZURE_OPENAI_ENDPOINT',
        configKey: 'azureOpenAI.endpoint',
        field: 'azureOpenaiEndpoint',
        secret: false,
        flag: undefined,
    },
    {
        variable: 'TESTPILOT_AZURE_MODEL_NAME',
        configKey: 'azureOpenAI.modelName',
        field: 'azureModelName',
        secret: false,
        flag: undefined,
    },
    {
        variable: 'TESTPILOT_AZURE_DEPLOYMENT_NAME',
        configKey: 'azureOpenAI.deploymentName',
        field: 'azureDeploymentName',
        secret: false,
        flag: undefined,
    },
    {
        variable: 'TESTPILOT_OPENAI_API_VERSION',
        configKey: 'azureOpenAI.apiVersion',
        field: 'openaiApiVersion',
        secret: false,
        flag: undefined,
    },
    {
        variable: 'TESTPILOT_AZURE_OPENAI_API_KEY',
        configKey: undefined,
        field: 'azureOpenaiApiKey',
        secret: true,
        flag: undefined,
    },
    {
        variable: 'TESTPILOT_SCRIPTS_DIR',
        configKey: 'scriptsDir',
        field: 'scriptsDir',
        secret: false,
        flag: '--out',
    },
    {
        variable: 'TESTPILOT_MAX_TURNS',
        configKey: 'maxTurns',
        field: 'mcpMaxTurns',
        secret: false,
        flag: '--max-turns',
    },
    {
        variable: 'TESTPILOT_LOCALE',
        configKey: 'locale',
        field: 'browserLocale',
        secret: false,
        flag: '--locale',
    },
    {
        variable: 'TESTPILOT_LOG_LEVEL',
        configKey: 'logLevel',
        field: 'logLevel',
        secret: false,
        flag: '--log-level',
    },
];

/** Settings together with the source each value came from. */
export interface LoadedSettings {
    settings: Settings;
    /** A setting with neither a value nor a default has no source. */
    sources: Partial<Record<SettingVariable, SettingSource>>;
}

/**
 * The nearest folder holding a `package.json`, looking upwards.
 *
 * @param start - Where to start looking; the working directory by default.
 * @returns `start` or its nearest ancestor with a `package.json`; `start`
 *   itself if none has one.
 */
export function findProjectRoot(start: string = process.cwd()): string {
    const origin = path.resolve(start);
    for (let folder = origin; ; folder = path.dirname(folder)) {
        if (existsSync(path.join(folder, 'package.json'))) {
            return folder;
        }
        if (path.dirname(folder) === folder) {
            return origin;
        }
    }
}

/**
 * Load settings for the project at `root`.
 *
 * @param env - The environment to read; `process.env` by default.
 * @param root - The project root; the nearest folder with a `package.json`
 *   by default.
 * @returns The validated settings.
 * @throws {ConfigurationError} If the config file or a value is invalid.
 * @see {@link resolveSettings}
 */
export function loadSettings(
    env: NodeJS.ProcessEnv = process.env,
    root: string = findProjectRoot(),
): Settings {
    return resolveSettings(env, root).settings;
}

/**
 * Load settings for the project at `root`, and where each value came from.
 *
 * Each source overrides the one before it: the defaults,
 * `.testpilot/config.json`, `.env`, `.env.local`, `env`, then `flags`. Only
 * `TESTPILOT_` variables are read, case-insensitively, so the project's own
 * variables are never picked up; the API key is only read from them.
 *
 * @param env - The environment to read; `process.env` by default.
 * @param root - The project root; the nearest folder with a `package.json`
 *   by default.
 * @param flags - The values of the command flags given, by the setting each
 *   overrides; none by default.
 * @returns The validated settings and the source of each value.
 * @throws {ConfigurationError} If the config file or a value is invalid; its
 *   `source` is where the first invalid value came from. A flag's value is
 *   reported under the flag's name, e.g. `--max-turns (from flag)`.
 */
export function resolveSettings(
    env: NodeJS.ProcessEnv = process.env,
    root: string = findProjectRoot(),
    flags: SettingFlags = {},
): LoadedSettings {
    const layers: [SettingSource, Record<string, string | undefined>][] = [
        ['config.json', readConfigFile(path.join(root, CONFIG_FILE))],
        ['.env', readEnvFile(path.join(root, '.env'))],
        ['.env.local', readEnvFile(path.join(root, '.env.local'))],
        ['environment', env],
        ['flag', flags],
    ];
    const values: Record<string, string> = {};
    const origins: Record<string, SettingSource> = {};
    for (const [source, layer] of layers) {
        for (const [key, value] of Object.entries(layer)) {
            if (value !== undefined) {
                values[key.toUpperCase()] = value;
                origins[key.toUpperCase()] = source;
            }
        }
    }

    const parsed = SettingsSchema.safeParse(values);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => {
            const variable = String(issue.path[0]);
            const source = origins[variable];
            const from = source === undefined ? '' : ` (from ${source})`;
            const name =
                source === 'flag'
                    ? (SETTINGS.find((spec) => spec.variable === variable)?.flag ??
                      variable)
                    : variable;
            return { source, text: `${name}${from}: ${issue.message}` };
        });
        throw new ConfigurationError(issues.map(({ text }) => text).join('\n'), {
            source: issues[0]?.source,
        });
    }
    const data = parsed.data;
    const settings: Settings = {
        llmProvider: data.TESTPILOT_LLM_PROVIDER,
        azureOpenaiEndpoint: data.TESTPILOT_AZURE_OPENAI_ENDPOINT,
        azureOpenaiApiKey: data.TESTPILOT_AZURE_OPENAI_API_KEY,
        azureDeploymentName: data.TESTPILOT_AZURE_DEPLOYMENT_NAME,
        azureModelName: data.TESTPILOT_AZURE_MODEL_NAME,
        openaiApiVersion: data.TESTPILOT_OPENAI_API_VERSION,
        scriptsDir: data.TESTPILOT_SCRIPTS_DIR,
        browserLocale: data.TESTPILOT_LOCALE,
        mcpMaxTurns: data.TESTPILOT_MAX_TURNS,
        logLevel: data.TESTPILOT_LOG_LEVEL,
    };
    const sources: LoadedSettings['sources'] = {};
    for (const { variable, field } of SETTINGS) {
        const source =
            origins[variable] ??
            (settings[field] === undefined ? undefined : 'default');
        if (source !== undefined) {
            sources[variable] = source;
        }
    }
    return { settings, sources };
}

/**
 * The config file's top-level object, as written, without validating its keys.
 *
 * @param file - The path of the config file.
 * @returns The object, or `undefined` if the file does not exist.
 * @throws {ConfigurationError} If the file cannot be read, is not valid JSON or
 *   is not a JSON object; its `source` is `config.json`.
 */
export async function readConfigObject(
    file: string,
): Promise<Record<string, unknown> | undefined> {
    let raw: unknown;
    try {
        raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        // A JSON syntax error is not kept: it quotes the file, which may hold a key.
        throw new ConfigurationError(`${CONFIG_FILE}: ${describeReadError(error)}`, {
            source: 'config.json',
            ...(error instanceof SyntaxError ? {} : { cause: error }),
        });
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ConfigurationError(`${CONFIG_FILE}: not a JSON object`, {
            source: 'config.json',
        });
    }
    return raw as Record<string, unknown>;
}

/**
 * The config file's settings, as the `TESTPILOT_` variables they stand for.
 *
 * @throws {ConfigurationError} If the file is not valid JSON, holds an unknown
 *   key or an invalid value, or holds an API key.
 */
function readConfigFile(file: string): Record<string, string> {
    if (!existsSync(file)) {
        return {};
    }
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new ConfigurationError(`${CONFIG_FILE}: ${describeReadError(error)}`, {
            source: 'config.json',
        });
    }
    if (hasApiKey(raw)) {
        throw new ApiKeyInConfigError(
            `API keys are not read from ${CONFIG_FILE}; set ${API_KEY_VARIABLE} ` +
                'in the environment, .env or .env.local',
            { source: 'config.json' },
        );
    }
    const parsed = ConfigFileSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ConfigurationError(
            `${CONFIG_FILE}: ${z.prettifyError(parsed.error)}`,
            {
                source: 'config.json',
            },
        );
    }
    const config = parsed.data;
    const variables = {
        TESTPILOT_LLM_PROVIDER: config.llmProvider,
        TESTPILOT_AZURE_OPENAI_ENDPOINT: config.azureOpenAI?.endpoint,
        TESTPILOT_AZURE_MODEL_NAME: config.azureOpenAI?.modelName,
        TESTPILOT_AZURE_DEPLOYMENT_NAME: config.azureOpenAI?.deploymentName,
        TESTPILOT_OPENAI_API_VERSION: config.azureOpenAI?.apiVersion,
        TESTPILOT_SCRIPTS_DIR: config.scriptsDir,
        TESTPILOT_MAX_TURNS: config.maxTurns?.toString(),
        TESTPILOT_LOCALE: config.locale,
        TESTPILOT_LOG_LEVEL: config.logLevel,
    };
    return Object.fromEntries(
        Object.entries(variables).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
}

/** Whether `value` holds a key named like an API key, at any depth. */
function hasApiKey(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    return Object.entries(value).some(
        ([key, child]) => API_KEY_NAME.test(key) || hasApiKey(child),
    );
}

// An assignment whose value is only blanks, which `parseEnv` would read as
// taking the next line for its value: `KEY= ` and the blanks.
const BLANK_VALUE =
    /^([ \t]*(?:export[ \t]+)?[^\s#=][^=\r\n]*?[ \t]*=)[ \t]+(?=\r?$)/gm;

/**
 * A dotenv file's variables, as `node:util`'s `parseEnv` reads them, except
 * that a value of only blanks is empty rather than the next line.
 *
 * @param text - The file's content.
 * @returns The variables it sets.
 */
export function readDotenv(text: string): Record<string, string | undefined> {
    return parseEnv(text.replace(BLANK_VALUE, '$1'));
}

/** A dotenv file's variables; none if the file does not exist. */
function readEnvFile(file: string): Record<string, string | undefined> {
    if (!existsSync(file)) {
        return {};
    }
    try {
        return readDotenv(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new ConfigurationError(`${path.basename(file)}: ${errorMessage(error)}`, {
            source: path.basename(file),
        });
    }
}

/**
 * Why the config file could not be read, without quoting its contents.
 *
 * A JSON syntax error's message quotes the text around the error, which may be
 * an API key; only its line and column are kept.
 */
function describeReadError(error: unknown): string {
    if (!(error instanceof SyntaxError)) {
        return errorMessage(error);
    }
    const where = /\(line \d+ column \d+\)/.exec(error.message)?.[0];
    return where === undefined ? 'not valid JSON' : `not valid JSON ${where}`;
}

/**
 * Configure logging based on the logLevel setting.
 *
 * @param settings - Settings to read logLevel from. Fresh settings are loaded
 *   if not provided. If that fails (e.g. an unsupported llmProvider),
 *   TESTPILOT_LOG_LEVEL is read directly from the environment so the failure
 *   can still be logged at the level the caller actually asked for.
 */
export function configureLogging(settings?: Settings): void {
    if (settings === undefined) {
        try {
            settings = loadSettings();
        } catch {
            settings = undefined;
        }
    }
    const fallback = (process.env.TESTPILOT_LOG_LEVEL ?? 'INFO').toUpperCase();
    const level =
        settings?.logLevel ??
        (LOG_LEVELS.includes(fallback as LogLevel) ? (fallback as LogLevel) : 'INFO');
    setLogLevel(level);
}
