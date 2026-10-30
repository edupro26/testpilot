/** Application logger: levelled, timestamped, colour-coded lines on stderr. */

import { inspect } from 'node:util';

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

function emit(level: LogLevel, message: string, error?: unknown): void {
    if (LOG_LEVELS.indexOf(level) < threshold) {
        return;
    }
    const time = new Date().toTimeString().slice(0, 8);
    const lines = [
        `[${time}] [${LEVEL_COLORS[level]}${level}${COLOR_RESET}] ${message}`,
    ];
    if (error !== undefined) {
        lines.push(formatError(error));
    }
    console.error(lines.join('\n'));
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
    warning: (message: string): void => {
        emit('WARNING', message);
    },
    /** Log `message`, followed by the stack of `error` when one is given. */
    error: (message: string, error?: unknown): void => {
        emit('ERROR', message, error);
    },
};
