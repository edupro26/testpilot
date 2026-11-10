/** Application logger: levelled, timestamped, colour-coded lines on stderr. */

import { appendFileSync } from 'node:fs';
import { inspect } from 'node:util';

import { errorMessage } from './runtime/exceptions.ts';

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_COLORS: Record<LogLevel, string> = {
    DEBUG: '\x1b[36m', // cyan
    INFO: '\x1b[32m', // green
    WARNING: '\x1b[33m', // yellow
    ERROR: '\x1b[31m', // red
    CRITICAL: '\x1b[1;31m', // bold red
};
const COLOR_RESET = '\x1b[0m';

let threshold = LOG_LEVELS.indexOf('INFO');

/**
 * Set the lowest level that is written.
 *
 * @param level - The minimum level; anything below it is dropped.
 */
export function setLogLevel(level: LogLevel): void {
    threshold = LOG_LEVELS.indexOf(level);
}

let logFile: string | undefined;

/**
 * Also append every emitted line to `file`.
 *
 * The file gets the same lines as standard error, at the same level, without
 * colour codes and with error stacks. Each line is written synchronously, so a
 * crash never loses the last ones. The folder must exist.
 *
 * @param file - The file to append to, or `undefined` to stop.
 */
export function setLogFile(file: string | undefined): void {
    logFile = file;
}

let lastLine = Date.now();

/**
 * When the last line was written, as `Date.now()` reads.
 *
 * Counts every line that passes the threshold, `logger.always` included; a
 * dropped line does not count.
 *
 * @returns The time of the last line, in ms since the epoch.
 */
export function lastLineAt(): number {
    return lastLine;
}

function emit(
    level: LogLevel,
    message: string,
    error?: unknown,
    ignoreThreshold = false,
): void {
    if (!ignoreThreshold && LOG_LEVELS.indexOf(level) < threshold) {
        return;
    }
    const time = new Date().toTimeString().slice(0, 8);
    const detail = error === undefined ? '' : `\n${formatError(error)}`;
    const colored = `${LEVEL_COLORS[level]}${level}${COLOR_RESET}`;
    console.error(`[${time}] [${colored}] ${message}${detail}`);
    lastLine = Date.now();
    if (logFile !== undefined) {
        try {
            appendFileSync(logFile, `[${time}] [${level}] ${message}${detail}\n`);
        } catch (failure) {
            // A broken log file must never end, or mask the outcome of, the run.
            const file = logFile;
            logFile = undefined;
            console.error(
                `[${time}] [${LEVEL_COLORS.WARNING}WARNING${COLOR_RESET}] ` +
                    `Cannot write to the log file ${file}, so it stops here: ` +
                    errorMessage(failure),
            );
        }
    }
}

/** Render `error` and its `cause` chain, stack traces included. */
function formatError(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    while (current !== undefined) {
        if (current instanceof Error) {
            parts.push(current.stack ?? `${current.name}: ${current.message}`);
            current = current.cause;
        } else {
            parts.push(inspect(current));
            current = undefined;
        }
    }
    return parts.join('\n\nCaused by:\n');
}

/** The shared application logger. */
export const logger = {
    debug: (message: string): void => {
        emit('DEBUG', message);
    },
    info: (message: string): void => {
        emit('INFO', message);
    },
    /** Log `message` as an INFO line whatever the level, e.g. where the log is. */
    always: (message: string): void => {
        emit('INFO', message, undefined, true);
    },
    warning: (message: string): void => {
        emit('WARNING', message);
    },
    /** Log `message`, followed by the stack of `error` when one is given. */
    error: (message: string, error?: unknown): void => {
        emit('ERROR', message, error);
    },
    /** Log `message` as `error` does, whatever the level, e.g. why a command failed. */
    alwaysError: (message: string, error?: unknown): void => {
        emit('ERROR', message, error, true);
    },
};
