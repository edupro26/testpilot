/** Shared test setup. */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, type MockInstance, vi } from 'vitest';

import { SETTINGS } from '../src/config.ts';

/**
 * Isolate settings from the real environment and any local .env file.
 *
 * Each test runs in a fresh temporary working directory, which is also where
 * the pipeline writes its outputs (the scripts folder and `.testpilot/`), and a
 * `package.json` that makes it the project root.
 */
export function useIsolatedSettingsEnv(): void {
    let previousCwd = process.cwd();

    beforeEach(async () => {
        for (const { variable } of SETTINGS) {
            vi.stubEnv(variable, undefined);
        }
        previousCwd = process.cwd();
        const cwd = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
        // Pins the project root here, whatever the temporary folder's ancestors hold.
        await writeFile(path.join(cwd, 'package.json'), '{}');
        process.chdir(cwd);
    });

    afterEach(() => {
        process.chdir(previousCwd);
        vi.unstubAllEnvs();
    });
}

let stdoutSpy: MockInstance<typeof process.stdout.write> | undefined;
let stderrSpies: MockInstance[] = [];

/**
 * Capture, and silence, what each test prints.
 *
 * Standard output is `process.stdout.write`. Standard error is `console.error`,
 * which the logger writes through, and `process.stderr.write`, which commander
 * writes its usage errors to. Read the capture with {@link stdout} and
 * {@link stderr}; it starts empty in every test.
 */
export function useCapturedOutput(): void {
    beforeEach(() => {
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        stderrSpies = [
            vi.spyOn(console, 'error').mockImplementation(() => undefined),
            vi.spyOn(process.stderr, 'write').mockReturnValue(true),
        ];
    });

    afterEach(() => {
        stdoutSpy?.mockRestore();
        for (const spy of stderrSpies) {
            spy.mockRestore();
        }
        stdoutSpy = undefined;
        stderrSpies = [];
    });
}

function printed(calls: unknown[][], separator: string): string {
    return calls.map(([chunk]) => String(chunk)).join(separator);
}

/** Everything written to standard output since the test began. */
export function stdout(): string {
    return printed(stdoutSpy?.mock.calls ?? [], '');
}

/**
 * Everything written to standard error since the test began: each
 * `console.error` call ends its line, as it does on a terminal.
 */
export function stderr(): string {
    const [logged, written] = stderrSpies;
    const lines = (logged?.mock.calls ?? []).map(
        (args) => `${args.map(String).join(' ')}\n`,
    );
    return lines.join('') + printed(written?.mock.calls ?? [], '');
}
