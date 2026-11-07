/** The `testpilot` command: parses arguments and dispatches to a command. */

import { Command, CommanderError } from 'commander';

import { doctorCommand } from './doctor.ts';
import { CliExit } from './errors.ts';
import { generateCommand } from './generate.ts';
import { initCommand } from './init.ts';

/**
 * The commander program, with every command registered.
 *
 * @returns The program, set to throw rather than exit.
 */
export function buildProgram(): Command {
    const program = new Command()
        .name('testpilot')
        .description('Turn markdown test cases into Playwright test scripts.')
        .exitOverride();

    program
        .command('generate')
        .summary('generate a Playwright script from a markdown test case')
        .description(
            'Run the full pipeline on a markdown test case and persist its output.\n\n' +
                'Writes the validated test case JSON and the generated script to ' +
                'output/<parent folder>/<stem>.{json,spec.ts}.',
        )
        .argument('<markdown_path>', 'the markdown test case specification')
        .action(generateCommand);

    program
        .command('doctor')
        .description(
            'Check that testpilot and this project are set up, and print the fix ' +
                'for anything missing.',
        )
        .action(doctorCommand);

    program
        .command('init')
        .description(
            'Set testpilot up in this project: check the setup and create .testpilot/.',
        )
        .action(() => initCommand());

    return program;
}

/**
 * Parse `argv` and run the CLI.
 *
 * @param argv - The arguments after the executable and script names.
 * @returns The process exit status.
 */
export async function runCli(argv: string[]): Promise<number> {
    try {
        await buildProgram().parseAsync(argv, { from: 'user' });
        return 0;
    } catch (error) {
        if (error instanceof CliExit || error instanceof CommanderError) {
            return error.exitCode;
        }
        throw error;
    }
}
