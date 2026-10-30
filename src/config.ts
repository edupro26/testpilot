/** Application settings and logging configuration. */

import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { z } from 'zod';

import { ConfigurationError } from './exceptions.ts';
import { LOG_LEVELS, type LogLevel, setLogLevel } from './logger.ts';

/** Supported values for the LLM_PROVIDER setting. */
export const LLM_PROVIDER_NAMES = ['mock', 'azure_openai'] as const;

export type LLMProviderName = (typeof LLM_PROVIDER_NAMES)[number];

const SettingsSchema = z.object({
    LLM_PROVIDER: z.enum(LLM_PROVIDER_NAMES).default('mock'),

    AZURE_OPENAI_ENDPOINT: z.string().optional(),
    AZURE_OPENAI_API_KEY: z.string().optional(),
    AZURE_DEPLOYMENT_NAME: z.string().optional(),
    AZURE_MODEL_NAME: z.string().optional(),
    OPENAI_API_VERSION: z.string().optional(),

    // Shared by the MCP browser, the validation browser and the generated script,
    // since sites localise by Accept-Language.
    BROWSER_LOCALE: z.string().default('en-US'),

    MCP_MAX_TURNS: z.coerce.number().int().positive().default(25),

    LOG_LEVEL: z
        .string()
        .transform((value) => value.toUpperCase())
        .pipe(z.enum(LOG_LEVELS))
        .default('INFO'),
});

/** Typed application settings loaded from the environment or .env file. */
export interface Settings {
    llmProvider: LLMProviderName;
    azureOpenaiEndpoint: string | undefined;
    azureOpenaiApiKey: string | undefined;
    azureDeploymentName: string | undefined;
    azureModelName: string | undefined;
    openaiApiVersion: string | undefined;
    browserLocale: string;
    mcpMaxTurns: number;
    logLevel: LogLevel;
}

/**
 * Load settings from the environment, falling back to a `.env` file.
 *
 * Variable names are case-insensitive, and the environment wins over the file.
 *
 * @param env - The environment to read; `process.env` by default.
 * @param envFile - The dotenv file to fall back to, relative to the cwd.
 * @returns The validated settings.
 * @throws {ConfigurationError} If a value is missing or invalid.
 */
export function loadSettings(
    env: NodeJS.ProcessEnv = process.env,
    envFile = '.env',
): Settings {
    const fileValues = existsSync(envFile)
        ? parseEnv(readFileSync(envFile, 'utf8'))
        : {};
    const values = Object.fromEntries(
        [...Object.entries(fileValues), ...Object.entries(env)].map(([key, value]) => [
            key.toUpperCase(),
            value,
        ]),
    );

    const parsed = SettingsSchema.safeParse(values);
    if (!parsed.success) {
        throw new ConfigurationError(z.prettifyError(parsed.error));
    }
    const data = parsed.data;
    return {
        llmProvider: data.LLM_PROVIDER,
        azureOpenaiEndpoint: data.AZURE_OPENAI_ENDPOINT,
        azureOpenaiApiKey: data.AZURE_OPENAI_API_KEY,
        azureDeploymentName: data.AZURE_DEPLOYMENT_NAME,
        azureModelName: data.AZURE_MODEL_NAME,
        openaiApiVersion: data.OPENAI_API_VERSION,
        browserLocale: data.BROWSER_LOCALE,
        mcpMaxTurns: data.MCP_MAX_TURNS,
        logLevel: data.LOG_LEVEL,
    };
}

/**
 * Configure logging based on the LOG_LEVEL setting.
 *
 * @param settings - Settings to read LOG_LEVEL from. Fresh settings are loaded
 *   from the environment if not provided. If that fails (e.g. an unsupported
 *   LLM_PROVIDER), LOG_LEVEL is read directly from the environment so the
 *   failure can still be logged at the level the caller actually asked for.
 */
export function configureLogging(settings?: Settings): void {
    if (settings === undefined) {
        try {
            settings = loadSettings();
        } catch {
            settings = undefined;
        }
    }
    const fallback = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase();
    const level =
        settings?.logLevel ??
        (LOG_LEVELS.includes(fallback as LogLevel) ? (fallback as LogLevel) : 'INFO');
    setLogLevel(level);
}
