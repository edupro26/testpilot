#!/usr/bin/env node
/**
 * The `testpilot` executable: runs the CLI on the process arguments.
 *
 * Plain JavaScript, checking the Node.js version before the CLI loads: older
 * Node cannot load TypeScript, or parse the CLI, so it would fail with an
 * unknown file extension or a SyntaxError before `doctor` could say why.
 */

/** As in `src/cli/node-version.ts`, which this file cannot import. */
const MIN_NODE_MAJOR = 24;

const version = process.versions.node;
if (Number(version.split('.')[0]) >= MIN_NODE_MAJOR) {
    const { runCli } = await import('./cli/cli.ts');
    process.exitCode = await runCli(process.argv.slice(2));
} else {
    console.error(
        `testpilot needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${version}.`,
    );
    process.exitCode = 2;
}
