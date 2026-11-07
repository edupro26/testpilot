/** Application settings and logging configuration. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { z } from 'zod';

import { LOG_LEVELS, type LogLevel, setLogLevel } from './logger.ts';
import { ConfigurationError, errorMessage } from './runtime/exceptions.ts';

/** Supported values for the llmProvider setting. */
export const LLM_PROVIDER_NAMES = ['azure_openai'] as const;

export type LLMProviderName = (typeof LLM_PROVIDER_NAMES)[number];

/** The project folder testpilot keeps its files in. */
export const CONFIG_DIR = '.testpilot';

/** The project's settings file, relative to the project root. */
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const API_KEY_VARIABLE = 'TESTPILOT_AZURE_OPENAI_API_KEY';

const LogLevelSchema = z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(LOG_LEVELS));

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
    TESTPILOT_SCRIPTS_DIR: z.string().default('tests/testpilot'),

    // Shared by the MCP browser, the validation browser and the generated script,
    // since sites localise by Accept-Language.
    TESTPILOT_LOCALE: z.string().default('en-US'),

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

/**
 * Load settings for the project at `root`.
 *
 * Each source overrides the one before it: the defaults,
 * `.testpilot/config.json`, `.env`, `.env.local`, then `env`. Only
 * `TESTPILOT_` variables are read, case-insensitively, so the project's own
 * variables are never picked up; the API key is only read from them.
 *
 * @param env - The environment to read; `process.env` by default.
 * @param root - The project root; the working directory by default.
 * @returns The validated settings.
 * @throws {ConfigurationError} If the config file or a value is invalid.
 */
export function loadSettings(
    env: NodeJS.ProcessEnv = process.env,
    root: string = process.cwd(),
): Settings {
    const sources = [
        readConfigFile(path.join(root, CONFIG_FILE)),
        readEnvFile(path.join(root, '.env')),
        readEnvFile(path.join(root, '.env.local')),
        env,
    ];
    const values = Object.fromEntries(
        sources.flatMap((source) =>
            Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]),
        ),
    );

    const parsed = SettingsSchema.safeParse(values);
    if (!parsed.success) {
        throw new ConfigurationError(z.prettifyError(parsed.error));
    }
    const data = parsed.data;
    return {
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
        throw new ConfigurationError(`${CONFIG_FILE}: ${describeReadError(error)}`);
    }
    if (hasApiKey(raw)) {
        throw new ConfigurationError(
            `API keys are not read from ${CONFIG_FILE}; set ${API_KEY_VARIABLE} ` +
                'in the environment, .env or .env.local',
        );
    }
    const parsed = ConfigFileSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ConfigurationError(
            `${CONFIG_FILE}: ${z.prettifyError(parsed.error)}`,
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
        ([key, child]) => /^api[_-]?key$/i.test(key) || hasApiKey(child),
    );
}

/** A dotenv file's variables; none if the file does not exist. */
function readEnvFile(file: string): Record<string, string | undefined> {
    if (!existsSync(file)) {
        return {};
    }
    try {
        return parseEnv(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new ConfigurationError(`${path.basename(file)}: ${errorMessage(error)}`);
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
