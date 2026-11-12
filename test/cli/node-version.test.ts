/** Tests for src/cli/node-version, and the executable's check of it. */

import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

import { unsupportedNode } from '../../src/cli/node-version.ts';

test('Node.js older than 24 is refused, naming both versions', () => {
    expect(unsupportedNode('24.0.0')).toBeUndefined();
    expect(unsupportedNode('26.1.0')).toBeUndefined();
    expect(unsupportedNode('22.12.0')).toBe(
        'testpilot needs Node.js 24 or newer; this is 22.12.0.',
    );
});

test('the executable loads only the version check before checking', async () => {
    // Older Node cannot parse the CLI (`await using`): importing it statically
    // would fail with a SyntaxError before the check could run.
    const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const imports = [...main.matchAll(/^import .* from '(.+)';$/gm)].map(
        ([, from]) => from,
    );

    expect(imports).toEqual(['./cli/node-version.ts']);
});
