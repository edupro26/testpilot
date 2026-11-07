/** How CLI commands fail: a logged error, then an exit status. */

import { configureLogging, loadSettings, type Settings } from '../config.ts';
import { logger } from '../logger.ts';
import { errorMessage } from '../runtime/exceptions.ts';

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
 * @returns The validated settings, with logging configured from them.
 * @throws {CliExit} With status 2, if the configuration is invalid.
 */
export function loadSettingsOrFail(): Settings {
    let settings: Settings;
    try {
        settings = loadSettings();
    } catch (error) {
        configureLogging();
        fail(`Invalid configuration: ${errorMessage(error)}`, error, 2);
    }
    configureLogging(settings);
    return settings;
}
