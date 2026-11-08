/** How CLI commands fail: a logged error, then an exit status. */

import {
    configureLogging,
    findProjectRoot,
    resolveSettings,
    type SettingFlags,
    type Settings,
} from '../config.ts';
import { logger } from '../logger.ts';
import {
    BrowserLaunchError,
    ConfigurationError,
    errorMessage,
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

/** The HTTP statuses that mean the setup is wrong, not the test case. */
const SETUP_STATUSES: readonly unknown[] = [401, 403, 404];

/** Whether `error` carries an HTTP status that means the setup is wrong. */
function hasSetupStatus(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        SETUP_STATUSES.includes(error.status)
    );
}

/**
 * Tell a setup problem from a test case that failed to generate.
 *
 * A setup problem is a `ConfigurationError`, a `BrowserLaunchError`, or an HTTP
 * 401, 403 or 404 from the LLM service (a wrong key, no access, or a wrong
 * endpoint or deployment), found in `error` or anywhere in its `cause` chain.
 *
 * @param error - The failure that ended a pipeline run.
 * @returns `2` for a setup problem, `1` for anything else.
 */
export function exitCodeFor(error: unknown): 1 | 2 {
    const seen = new Set<unknown>();
    for (let current = error; current !== undefined && !seen.has(current);) {
        seen.add(current);
        if (
            current instanceof ConfigurationError ||
            current instanceof BrowserLaunchError ||
            hasSetupStatus(current)
        ) {
            return 2;
        }
        current = current instanceof Error ? current.cause : undefined;
    }
    return 1;
}

/**
 * Log `message` as a single clear error and end with `exitCode`.
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
    if (traceback) {
        logger.error(message, error);
    } else {
        logger.error(message);
    }
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
        fail(`Invalid configuration: ${errorMessage(error)}`, error, 2);
    }
    configureLogging(settings);
    return settings;
}
