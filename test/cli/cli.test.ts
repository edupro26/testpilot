import { describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli/cli.ts';
import { useCapturedOutput, useIsolatedSettingsEnv } from '../helpers.ts';

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
    ])('testpilot %j exits %i', async (argv, code) => {
        expect(await runCli(argv)).toBe(code);
    });
});
