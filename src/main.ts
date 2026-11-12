#!/usr/bin/env node
/** The `testpilot` executable: runs the CLI on the process arguments. */

import { unsupportedNode } from './cli/node-version.ts';

// Checked before the CLI loads: older Node cannot even parse it, and would
// fail with a SyntaxError before `doctor` could say why.
const unsupported = unsupportedNode(process.versions.node);
if (unsupported === undefined) {
    const { runCli } = await import('./cli/cli.ts');
    process.exitCode = await runCli(process.argv.slice(2));
} else {
    console.error(unsupported);
    process.exitCode = 2;
}
