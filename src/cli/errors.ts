/** How CLI commands fail: a logged error, then an exit status. */

import { APIConnectionError, APIError } from 'openai';

import {
    configureLogging,
    findProjectRoot,
    resolveSettings,
    type SettingFlags,
    type Settings,
} from '../config.ts';
import { ERROR_CODES, type ErrorCode } from '../error-codes.ts';
import { logger } from '../logger.ts';
import {
    ApiKeyInConfigError,
    BrowserLaunchError,
    ConfigurationError,
    errorMessage,
    MissingSettingsError,
    PipelineError,
} from '../runtime/exceptions.ts';

/** Ends the CLI with `exitCode`, after the failure has been logged. */
export class CliExit extends Error {
    override name = 'CliExit';
    readonly exitCode: number;

    /**
     * Initialize with the process exit code.
     *
     * @param exitCode - The status the process should exit with.
     * @param options - The failure that ended the run, as `cause`.
     */
    constructor(exitCode: number, options?: ErrorOptions) {
        super(`exit ${exitCode}`, options);
        this.exitCode = exitCode;
    }
}

/** A command line that cannot be run as typed, e.g. an input file that is missing. */
export class UsageError extends Error {
    override name = 'UsageError';
}

/** The log folder of a run cannot be created. */
export class LogFolderError extends Error {
    override name = 'LogFolderError';
}

/** A run would overwrite the outputs of another input with the same name. */
export class OutputConflictError extends Error {
    override name = 'OutputConflictError';
}

/** `error` and its `cause` chain, outermost first; ends at a repeat or a non-Error. */
function causeChain(error: unknown): Error[] {
    const chain: Error[] = [];
    for (let current = error; current instanceof Error && !chain.includes(current);) {
        chain.push(current);
        current = current.cause;
    }
    return chain;
}

/** The HTTP status `error` carries, if it has a numeric one. */
function statusOf(error: Error): number | undefined {
    return 'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined;
}

/**
 * The rules that give a failure its code, most specific first. The first rule
 * that matches any error in the cause chain decides.
 */
const CODE_RULES: readonly [
    matches: (error: Error) => boolean,
    code: (error: Error) => ErrorCode,
][] = [
    [(error) => error instanceof UsageError, () => 'INPUT_NOT_FOUND'],
    [(error) => error instanceof LogFolderError, () => 'LOG_DIR_FAILED'],
    [(error) => error instanceof OutputConflictError, () => 'OUTPUT_CONFLICT'],
    [(error) => error instanceof ApiKeyInConfigError, () => 'API_KEY_IN_CONFIG'],
    [(error) => error instanceof MissingSettingsError, () => 'LLM_SETTINGS_MISSING'],
    [(error) => error instanceof ConfigurationError, () => 'CONFIG_INVALID'],
    [(error) => error instanceof BrowserLaunchError, () => 'BROWSER_LAUNCH_FAILED'],
    [(error) => [401, 403].includes(statusOf(error) ?? 0), () => 'LLM_AUTH_FAILED'],
    [(error) => statusOf(error) === 404, () => 'LLM_NOT_FOUND'],
    [(error) => statusOf(error) === 429, () => 'LLM_RATE_LIMITED'],
    [(error) => error instanceof APIConnectionError, () => 'LLM_UNREACHABLE'],
    [
        (error) => error instanceof APIError || statusOf(error) !== undefined,
        () => 'LLM_REQUEST_FAILED',
    ],
    [
        (error) => error instanceof PipelineError,
        (error) => (error as PipelineError).code,
    ],
];

/**
 * Classify a failure that ended a run.
 *
 * Looks at `error` and its `cause` chain; a rule that matches anywhere in the
 * chain beats a later rule, so a `BrowserLaunchError` inside an `McpError` is
 * `BROWSER_LAUNCH_FAILED`, not `BROWSER_AGENT_FAILED`.
 *
 * @param error - The failure that ended a run.
 * @returns Its stable code; `INTERNAL_ERROR` if nothing matches.
 */
export function errorCodeFor(error: unknown): ErrorCode {
    const chain = causeChain(error);
    for (const [matches, code] of CODE_RULES) {
        const found = chain.find(matches);
        if (found !== undefined) {
            return code(found);
        }
    }
    return 'INTERNAL_ERROR';
}

/**
 * Tell a setup problem from a test case that failed to generate.
 *
 * @param error - The failure that ended a pipeline run.
 * @returns `2` for a setup problem, `1` for anything else; see `ERROR_CODES`.
 */
export function exitCodeFor(error: unknown): 1 | 2 {
    return ERROR_CODES[errorCodeFor(error)].exitCode;
}

/**
 * Log `message` as a single clear error and end with `exitCode`.
 *
 * The error is logged whatever the log level.
 *
 * @param message - The one-line description of the failure.
 * @param error - The failure, kept as the exit's `cause`.
 * @param exitCode - The status the process should exit with.
 * @param traceback - Whether to log `error`'s stack trace too.
 * @throws {CliExit} Always.
 */
export function fail(
    message: string,
    error: unknown,
    exitCode: number,
    traceback = false,
): never {
    logger.alwaysError(message, traceback ? error : undefined);
    throw new CliExit(exitCode, { cause: error });
}

/**
 * Log a failure as `CODE: message` and its hint, and end with the code's exit status.
 *
 * Both lines are logged whatever the log level.
 *
 * @param message - The one-line description of the failure.
 * @param error - The failure, classified by `errorCodeFor` and kept as the
 *   exit's `cause`. Its stack trace is logged too unless it is a setup problem.
 * @throws {CliExit} Always.
 */
export function failWithCode(message: string, error: unknown): never {
    const code = errorCodeFor(error);
    const { exitCode, hint } = ERROR_CODES[code];
    // A setup problem is the developer's to fix; its stack is only noise.
    logger.alwaysError(`${code}: ${message}`, exitCode === 1 ? error : undefined);
    logger.alwaysError(`Hint: ${hint}`);
    throw new CliExit(exitCode, { cause: error });
}

/**
 * Load settings, exiting with a clear error if they are invalid.
 *
 * @param flags - The command flags given, which override every other source.
 * @returns The validated settings, with logging configured from them.
 * @throws {CliExit} With status 2, if the configuration is invalid.
 */
export function loadSettingsOrFail(flags: SettingFlags = {}): Settings {
    let settings: Settings;
    try {
        settings = resolveSettings(process.env, findProjectRoot(), flags).settings;
    } catch (error) {
        configureLogging();
        failWithCode(`Invalid configuration: ${errorMessage(error)}`, error);
    }
    configureLogging(settings);
    return settings;
}
