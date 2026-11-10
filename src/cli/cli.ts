/** The `testpilot` command: parses arguments and dispatches to a command. */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Command, CommanderError } from 'commander';

import {
    configListCommand,
    configSetAzureOpenAICommand,
    parseSave,
    type SetAzureOptions,
} from './config.ts';
import { doctorCommand } from './doctor.ts';
import { CliExit } from './errors.ts';
import { generateCommand } from './generate.ts';
import { initCommand } from './init.ts';
import { SKILL_AGENTS, type SkillAgent } from './skills.ts';

/** The version in testpilot's own `package.json`. */
const VERSION = (
    JSON.parse(
        readFileSync(
            path.resolve(import.meta.dirname, '..', '..', 'package.json'),
            'utf8',
        ),
    ) as { version: string }
).version;

/**
 * The commander program, with every command registered.
 *
 * @returns The program, set to throw rather than exit.
 */
export function buildProgram(): Command {
    const program = new Command()
        .name('testpilot')
        .description('Turn markdown test cases into Playwright test scripts.')
        .version(VERSION)
        .exitOverride();

    program
        .command('generate')
        .summary('generate a Playwright script from a markdown test case')
        .description(
            'Run the full pipeline on a markdown test case and persist its output.\n\n' +
                'Writes the generated script to the scripts folder (scriptsDir), the ' +
                'validated test case JSON to .testpilot/tests/, and a log of the run ' +
                'to .testpilot/logs/.',
        )
        .argument('<markdown_path>', 'the markdown test case specification')
        .option('--headed', 'show the browser the agent drives')
        .option(
            '--out <dir>',
            'folder for the generated script, relative to the working directory ' +
                '(overrides scriptsDir)',
        )
        .option('--max-turns <n>', 'maximum agent turns per step (overrides maxTurns)')
        .option('--locale <locale>', 'browser locale (overrides locale)')
        .option('--log-level <level>', 'logging level (overrides logLevel)')
        .option(
            '--json',
            'print the result as one JSON object on standard output instead of ' +
                'the three paths',
        )
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
            'Set testpilot up in this project: check the setup and create ' +
                '.testpilot/. With --skills, also install the testpilot skill for AI ' +
                'agents.',
        )
        .option(
            '--skills [agent]',
            'install the testpilot skill for an AI agent: agents (the default, ' +
                'in .agents/skills/), copilot or claude',
        )
        .option(
            '-g, --global',
            'with --skills, install it for the user (in the home folder), not the ' +
                'project',
        )
        .action(
            async (
                options: { skills?: string | true; global?: boolean },
                command: Command,
            ) => {
                if (options.global === true && options.skills === undefined) {
                    command.error('error: -g, --global needs --skills');
                }
                const agent = options.skills === true ? 'agents' : options.skills;
                if (agent !== undefined && !isSkillAgent(agent)) {
                    command.error(
                        `error: unknown agent '${agent}' for --skills; use ` +
                            `${SKILL_AGENTS.slice(0, -1).join(', ')} or ` +
                            `${SKILL_AGENTS.at(-1)}`,
                    );
                }
                await initCommand({ skills: agent, global: options.global });
            },
        );

    const config = program
        .command('config')
        .description('Inspect and change the settings testpilot uses.');

    config
        .command('list')
        .description(
            'Print every effective setting and where its value came from. The API ' +
                'key is masked.',
        )
        .action(() => {
            configListCommand();
        });

    config
        .command('set-azure-openai')
        .description(
            'Write the Azure OpenAI settings to .testpilot/config.json. The API key ' +
                'is never a flag: --prompt-api-key asks for it with hidden input and ' +
                'writes it to a dotenv file.',
        )
        .option('--endpoint <endpoint>', 'the Azure OpenAI endpoint')
        .option('--model-name <name>', 'the model behind the deployment')
        .option('--deployment-name <name>', 'the Azure deployment name')
        .option('--api-version <version>', 'the Azure OpenAI API version')
        .option(
            '--prompt-api-key',
            'ask for the API key (hidden input) and write it to a dotenv file',
        )
        .option(
            '--save <target>',
            'also write the values to a dotenv file: dotenv or dotenv:<path> ' +
                '(default .env.local)',
            parseSave,
        )
        .action((options: SetAzureOptions) => configSetAzureOpenAICommand(options));

    return program;
}

function isSkillAgent(value: string): value is SkillAgent {
    return (SKILL_AGENTS as readonly string[]).includes(value);
}

/**
 * Parse `argv` and run the CLI.
 *
 * @param argv - The arguments after the executable and script names.
 * @returns The process exit status: `0` for success and for help or version
 *     output, `2` for any commander usage error (an unknown command or option, a
 *     missing argument, an invalid option value), else the command's own status.
 */
export async function runCli(argv: string[]): Promise<number> {
    try {
        await buildProgram().parseAsync(argv, { from: 'user' });
        return 0;
    } catch (error) {
        if (error instanceof CommanderError) {
            return error.exitCode === 0 ? 0 : 2;
        }
        if (error instanceof CliExit) {
            return error.exitCode;
        }
        throw error;
    }
}
