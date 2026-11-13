/** Tests for src/cli/node-version, and the executable's check of it. */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { unsupportedNode } from '../../src/cli/node-version.ts';

const execFileAsync = promisify(execFile);

/** The `testpilot` executable. */
const MAIN = fileURLToPath(new URL('../../src/main.js', import.meta.url));

test('Node.js older than 24 is refused, naming both versions', () => {
    expect(unsupportedNode('24.0.0')).toBeUndefined();
    expect(unsupportedNode('26.1.0')).toBeUndefined();
    expect(unsupportedNode('22.12.0')).toBe(
        'testpilot needs Node.js 24 or newer; this is 22.12.0.',
    );
});

/**
 * Run the executable as Node.js `version` would: without type stripping, which
 * Node before 22.18 lacks.
 */
async function runAs(
    version: string,
    args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
    const fake =
        "Object.defineProperty(process, 'versions', " +
        `{ value: { ...process.versions, node: '${version}' } });`;
    const argv = [
        '--no-experimental-strip-types',
        `--import=data:text/javascript,${encodeURIComponent(fake)}`,
        MAIN,
        ...args,
    ];
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, argv);
        return { code: 0, stdout, stderr };
    } catch (error) {
        const { code, stdout, stderr } = error as {
            code: number;
            stdout: string;
            stderr: string;
        };
        return { code, stdout, stderr };
    }
}

test('without type stripping, the executable says which Node.js it needs', async () => {
    // The check must run before anything the old Node cannot load.
    const result = await runAs('20.11.0', ['doctor']);

    expect(result.stderr.trim()).toBe(unsupportedNode('20.11.0'));
    expect(result.code).toBe(2);
});

test('the executable runs the CLI on a supported Node.js', async () => {
    const { stdout } = await execFileAsync(process.execPath, [MAIN, '--version']);

    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});
