import { APIConnectionError } from 'openai';
import { expect, test } from 'vitest';

import { errorCodeFor, exitCodeFor, LogFolderError } from '../../src/cli/errors.ts';
import { UsageError } from '../../src/cli/errors.ts';
import { ERROR_CODES } from '../../src/error-codes.ts';
import {
    ApiKeyInConfigError,
    BrowserLaunchError,
    ConfigurationError,
    ExtractorError,
    McpError,
    MissingSettingsError,
} from '../../src/runtime/exceptions.ts';

/** An error that carries an HTTP status, as the OpenAI client's do. */
function status(code: number): Error {
    return Object.assign(new Error(`HTTP ${code}`), { status: code });
}

test('every code has an exit code and a hint', () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(20);
    for (const { exitCode, hint } of Object.values(ERROR_CODES)) {
        expect([1, 2]).toContain(exitCode);
        expect(hint.length).toBeGreaterThan(0);
    }
});

test.each([
    [new UsageError('x'), 'INPUT_NOT_FOUND'],
    [new LogFolderError('x', { cause: new Error('EACCES') }), 'LOG_DIR_FAILED'],
    [new ApiKeyInConfigError('x'), 'API_KEY_IN_CONFIG'],
    [new MissingSettingsError('x'), 'LLM_SETTINGS_MISSING'],
    [new ConfigurationError('x'), 'CONFIG_INVALID'],
    [status(401), 'LLM_AUTH_FAILED'],
    [status(403), 'LLM_AUTH_FAILED'],
    [status(404), 'LLM_NOT_FOUND'],
    [status(429), 'LLM_RATE_LIMITED'],
    [status(500), 'LLM_REQUEST_FAILED'],
    [new APIConnectionError({ message: 'down' }), 'LLM_UNREACHABLE'],
    [new ExtractorError('x', { code: 'STEP_OUT_OF_TURNS' }), 'STEP_OUT_OF_TURNS'],
    [new RangeError('bug'), 'INTERNAL_ERROR'],
    ['a string', 'INTERNAL_ERROR'],
])('%o is %s', (error, code) => {
    expect(errorCodeFor(error)).toBe(code);
});

test('the more specific cause wins over the wrapper', () => {
    const launch = new BrowserLaunchError('no chromium', {
        code: 'BROWSER_LAUNCH_FAILED',
    });
    const mcp = new McpError('start', { code: 'BROWSER_AGENT_FAILED', cause: launch });
    expect(errorCodeFor(mcp)).toBe('BROWSER_LAUNCH_FAILED');
    expect(exitCodeFor(mcp)).toBe(2);
    const wrapped = new Error('x', { cause: new ConfigurationError('y') });
    expect(errorCodeFor(wrapped)).toBe('CONFIG_INVALID');
});

test('a cause chain that loops still ends', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;
    expect(errorCodeFor(first)).toBe('INTERNAL_ERROR');
});

test('a code decides the exit code', () => {
    expect(exitCodeFor(status(401))).toBe(2);
    expect(exitCodeFor(new APIConnectionError({ message: 'down' }))).toBe(1);
    expect(exitCodeFor(new ExtractorError('x', { code: 'STEP_ABANDONED' }))).toBe(1);
    expect(exitCodeFor(new RangeError('bug'))).toBe(1);
    expect(exitCodeFor('a string')).toBe(1);
});
