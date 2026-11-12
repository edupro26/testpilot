import { describe, expect, test } from 'vitest';

import { reportUncaught, runCli } from '../../src/cli/cli.ts';
import { stderr, useCapturedOutput, useIsolatedSettingsEnv } from '../helpers.ts';

describe('runCli exit codes', () => {
    useIsolatedSettingsEnv();
    useCapturedOutput();

    test.each([
        [['--help'], 0],
        [['--version'], 0],
        [['help', 'generate'], 0],
        [['bogus'], 2],
        [['case.md'], 2],
        [['generate'], 2],
        [['generate', 'missing.md'], 2],
        [['generate', 'x.md', '--bogus'], 2],
        [['config', 'set-azure-openai'], 2],
        [['config', 'set-azure-openai', '--save=json'], 2],
        [['init', '-g'], 2],
        [['init', '--skills=cursor'], 2],
    ])('testpilot %j exits %i', async (argv, code) => {
        expect(await runCli(argv)).toBe(code);
    });

    test('an unknown --skills agent lists every agent, the default first', async () => {
        expect(await runCli(['init', '--skills=cursor'])).toBe(2);
        expect(stderr()).toContain(
            "unknown agent 'cursor' for --skills; use agents, copilot or claude",
        );
    });
});

describe('a failure no command handled', () => {
    useCapturedOutput();

    test('from the file system is a setup error, without a stack', () => {
        // commands.md: exit 1 means the test case failed to generate.
        const error = Object.assign(
            new Error("EACCES: permission denied, mkdir '/project/.testpilot'"),
            { code: 'EACCES', syscall: 'mkdir', path: '/project/.testpilot' },
        );

        expect(reportUncaught(error)).toBe(2);
        expect(stderr()).toContain(
            "EACCES: permission denied, mkdir '/project/.testpilot'",
        );
        expect(stderr()).not.toContain('    at ');
    });

    test('from anything else is reported as an internal error', () => {
        expect(reportUncaught(new TypeError('x is undefined'))).toBe(1);
        expect(stderr()).toContain('INTERNAL_ERROR: x is undefined');
        expect(stderr()).toContain('Hint: ');
    });
});
