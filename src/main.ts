#!/usr/bin/env node
/** The `testpilot` executable: runs the CLI on the process arguments. */

import { runCli } from './cli/cli.ts';

process.exitCode = await runCli(process.argv.slice(2));
