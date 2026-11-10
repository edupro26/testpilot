/** Tests for `testpilot --version` and the config command. */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { InvalidArgumentError } from 'commander';
import { expect, test, vi } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };
import { runCli } from '../../src/cli/cli.ts';
import {
    configSetAzureOpenAICommand,
    maskSecret,
    parseSave,
    readHiddenInput,
    updateDotenv,
} from '../../src/cli/config.ts';
import { resolveSettings } from '../../src/config.ts';
import {
    stderr,
    stdout,
    useCapturedOutput,
    useIsolatedSettingsEnv,
} from '../helpers.ts';

useIsolatedSettingsEnv();
useCapturedOutput();

/** Write `.testpilot/config.json` in the working directory. */
async function writeConfig(config: unknown): Promise<void> {
    await mkdir('.testpilot', { recursive: true });
    await writeFile(
        path.join('.testpilot', 'config.json'),
        typeof config === 'string' ? config : JSON.stringify(config),
    );
}

test('--version prints the package version', async () => {
    expect(await runCli(['--version'])).toBe(0);
    expect(stdout()).toBe(`${packageJson.version}\n`);
});

test('maskSecret keeps only the last 4 characters', () => {
    expect(maskSecret('sk-1234567890abcd')).toBe('****abcd');
    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('12345678')).toBe('****');
    expect(maskSecret('123456789')).toBe('****6789');
});

test('config list shows each value, its source, and masks the key', async () => {
    await writeConfig({ locale: 'pt-PT' });
    await writeFile('.env.local', 'TESTPILOT_MAX_TURNS=10\n');
    vi.stubEnv('TESTPILOT_AZURE_OPENAI_API_KEY', 'sk-1234567890abcd');

    expect(await runCli(['config', 'list'])).toBe(0);
    const lines = stdout().split('\n');
    expect(lines.find((l) => l.startsWith('locale'))).toMatch(
        /pt-PT.*\(config\.json\)/,
    );
    expect(lines.find((l) => l.startsWith('maxTurns'))).toMatch(/10.*\(\.env\.local\)/);
    expect(lines.find((l) => l.startsWith('scriptsDir'))).toMatch(
        /testpilot.*\(default\)/,
    );
    expect(lines.find((l) => l.startsWith('azureOpenAI.endpoint'))).toContain(
        '(not set)',
    );
    expect(lines.find((l) => l.startsWith('TESTPILOT_AZURE_OPENAI_API_KEY'))).toMatch(
        /\*\*\*\*abcd.*\(environment\)/,
    );
    expect(stdout()).not.toContain('sk-1234567890abcd');
});

test('config list with a broken config.json exits 2 naming the file', async () => {
    await writeConfig('{ not json');
    expect(await runCli(['config', 'list'])).toBe(2);
    expect(stderr()).toContain('.testpilot/config.json');
    expect(stdout()).toBe('');
});

test('updateDotenv replaces in place and keeps everything else', () => {
    const before =
        '# mine\r\nAPP=1\r\nexport TESTPILOT_AZURE_OPENAI_ENDPOINT=old\r\nZ=2';
    expect(
        updateDotenv(before, {
            TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://new/',
            TESTPILOT_AZURE_MODEL_NAME: 'gpt 5',
        }),
    ).toBe(
        '# mine\r\nAPP=1\r\n' +
            'export TESTPILOT_AZURE_OPENAI_ENDPOINT=https://new/\r\nZ=2\r\n' +
            'TESTPILOT_AZURE_MODEL_NAME="gpt 5"\r\n',
    );
});

test('updateDotenv replaces a name in any case, so the new value is read', async () => {
    const before =
        'testpilot_azure_openai_endpoint=https://old/\n' +
        'Testpilot_Azure_Openai_Endpoint=https://older/\n';
    const after = updateDotenv(before, {
        TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://new/',
    });
    expect(after).toBe('TESTPILOT_AZURE_OPENAI_ENDPOINT=https://new/\n'.repeat(2));
    await writeFile('.env.local', after);
    expect(resolveSettings({}, process.cwd()).settings.azureOpenaiEndpoint).toBe(
        'https://new/',
    );
});

test('updateDotenv quotes what a dotenv file would misread', () => {
    expect(updateDotenv('', { A: 'x#y', B: 'say "hi"', C: 'plain', D: "it's" })).toBe(
        'A="x#y"\nB=\'say "hi"\'\nC=plain\nD="it\'s"\n',
    );
});

test('updateDotenv writes values that parseEnv reads back unchanged', () => {
    const values = {
        A: 'x#y',
        B: 'say "hi"',
        C: "it's here",
        D: 'a\\nb c',
        E: ' padded ',
        F: 'a`b',
        G: 'https://x.openai.azure.com/?a=b&c=d',
        H: 'C:\\path\\to',
    };
    const parsed = parseEnv(updateDotenv('KEEP=1\n', values));
    expect({ ...parsed }).toEqual({ KEEP: '1', ...values });
});

test.each([
    ['both kinds of quote', 'say "it\'s"'],
    ['a newline', 'two\nlines'],
    ['a quote and a backslash-n', "it's a\\nb"],
])('updateDotenv refuses a value with %s, naming only the variable', (_, value) => {
    expect(() => updateDotenv('', { SOME_VAR: value })).toThrow(
        expect.objectContaining({
            name: 'ConfigurationError',
            message: expect.stringMatching(/^SOME_VAR: /) as unknown,
        }),
    );
});

test('updateDotenv appends on a new line and indents like the original', () => {
    expect(updateDotenv('A=1', { B: '2' })).toBe('A=1\nB=2\n');
    expect(updateDotenv('A=1\n', { B: '2' })).toBe('A=1\nB=2\n');
    expect(updateDotenv('  A=old\nB=2\n', { A: '$&' })).toBe('  A=$&\nB=2\n');
});

test('updateDotenv leaves the lines inside another quoted value alone', () => {
    const before =
        'APP_TEXT="first\nTESTPILOT_AZURE_OPENAI_ENDPOINT=inside\nlast" # note\n' +
        "MULTI='a\nb'\n" +
        'OPEN="never closed\nTESTPILOT_AZURE_MODEL_NAME=old\n';
    const after = updateDotenv(before, {
        TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://new/',
        MULTI: 'one',
        TESTPILOT_AZURE_MODEL_NAME: 'gpt',
    });
    expect(after).toBe(
        'APP_TEXT="first\nTESTPILOT_AZURE_OPENAI_ENDPOINT=inside\nlast" # note\n' +
            'MULTI=one\n' +
            'OPEN="never closed\nTESTPILOT_AZURE_MODEL_NAME=gpt\n' +
            'TESTPILOT_AZURE_OPENAI_ENDPOINT=https://new/\n',
    );
    // An unclosed quote is read as the rest of its line, so the next line counts.
    expect({ ...parseEnv(after) }).toEqual({
        APP_TEXT: 'first\nTESTPILOT_AZURE_OPENAI_ENDPOINT=inside\nlast',
        MULTI: 'one',
        OPEN: '"never closed',
        TESTPILOT_AZURE_MODEL_NAME: 'gpt',
        TESTPILOT_AZURE_OPENAI_ENDPOINT: 'https://new/',
    });
});

test('parseSave accepts dotenv and dotenv:<path> only', () => {
    expect(parseSave('dotenv')).toBe('');
    expect(parseSave('dotenv:config/.env')).toBe('config/.env');
    expect(() => parseSave('json')).toThrow(InvalidArgumentError);
});

test('values go to config.json, other keys kept', async () => {
    await writeConfig({ scriptsDir: 'e2e/testpilot' });
    await configSetAzureOpenAICommand({ endpoint: 'https://x/', modelName: 'gpt-5.5' });
    expect(JSON.parse(await readFile('.testpilot/config.json', 'utf8'))).toEqual({
        scriptsDir: 'e2e/testpilot',
        llmProvider: 'azure_openai',
        azureOpenAI: { endpoint: 'https://x/', modelName: 'gpt-5.5' },
    });
    expect(existsSync('.env.local')).toBe(false);
    expect(stdout()).toBe('updated .testpilot/config.json\n');
    expect(stderr()).toBe('');
});

test('config.json is created indented by 4, keeping earlier Azure values', async () => {
    await configSetAzureOpenAICommand({ deploymentName: 'd1', apiVersion: 'v1' });
    await configSetAzureOpenAICommand({ deploymentName: 'd2' });
    expect(await readFile('.testpilot/config.json', 'utf8')).toBe(
        JSON.stringify(
            {
                llmProvider: 'azure_openai',
                azureOpenAI: { deploymentName: 'd2', apiVersion: 'v1' },
            },
            null,
            4,
        ) + '\n',
    );
});

test('--prompt-api-key writes only the key to .env.local, never printed', async () => {
    await writeFile('.env.local', 'APP_SECRET=keep\n');
    await configSetAzureOpenAICommand(
        { promptApiKey: true },
        {
            isInteractive: () => true,
            readSecret: () => Promise.resolve('sk-secret-9999'),
        },
    );
    expect(await readFile('.env.local', 'utf8')).toBe(
        'APP_SECRET=keep\nTESTPILOT_AZURE_OPENAI_API_KEY=sk-secret-9999\n',
    );
    expect(existsSync('.testpilot/config.json')).toBe(false);
    expect(stdout()).toBe('updated .env.local (TESTPILOT_AZURE_OPENAI_API_KEY)\n');
    expect(stdout() + stderr()).not.toContain('sk-secret-9999');
});

test.skipIf(process.platform === 'win32')(
    '--prompt-api-key makes an existing dotenv file readable by its owner only',
    async () => {
        await writeFile('.env.local', 'APP_SECRET=keep\n');
        await chmod('.env.local', 0o644);
        await configSetAzureOpenAICommand(
            { promptApiKey: true },
            { isInteractive: () => true, readSecret: () => Promise.resolve('sk-1') },
        );
        expect((await stat('.env.local')).mode & 0o777).toBe(0o600);
    },
);

test.skipIf(process.platform === 'win32')(
    'writing values without the key leaves a dotenv file as readable as it was',
    async () => {
        await writeFile('.env.local', 'APP_SECRET=keep\n');
        await chmod('.env.local', 0o644);
        await configSetAzureOpenAICommand({ endpoint: 'https://x/', save: '' });
        expect((await stat('.env.local')).mode & 0o777).toBe(0o644);
    },
);

test('--save=dotenv:<path> writes there too, relative to the cwd', async () => {
    await mkdir('sub');
    process.chdir('sub');
    await configSetAzureOpenAICommand(
        { endpoint: 'https://x/', save: 'local.env', promptApiKey: true },
        { isInteractive: () => true, readSecret: () => Promise.resolve('sk-1') },
    );
    expect(await readFile('local.env', 'utf8')).toBe(
        'TESTPILOT_AZURE_OPENAI_ENDPOINT=https://x/\n' +
            'TESTPILOT_AZURE_OPENAI_API_KEY=sk-1\n',
    );
    expect(existsSync('../.env.local')).toBe(false);
    expect(
        JSON.parse(await readFile('../.testpilot/config.json', 'utf8')),
    ).toMatchObject({ azureOpenAI: { endpoint: 'https://x/' } });
    expect(existsSync('.testpilot')).toBe(false);
    // The dotenv file first: if it cannot be written, config.json is untouched.
    expect(stdout()).toBe(
        'updated local.env (TESTPILOT_AZURE_OPENAI_ENDPOINT, ' +
            'TESTPILOT_AZURE_OPENAI_API_KEY)\n' +
            'updated ../.testpilot/config.json\n',
    );
});

test('an overridden value is written, with a warning naming the source', async () => {
    await writeFile(
        '.env.local',
        'TESTPILOT_AZURE_OPENAI_ENDPOINT=https://old-host/\n',
    );
    vi.stubEnv('TESTPILOT_AZURE_OPENAI_API_KEY', 'sk-shell-1111');

    await configSetAzureOpenAICommand(
        { endpoint: 'https://new-host/', promptApiKey: true },
        { isInteractive: () => true, readSecret: () => Promise.resolve('sk-new-2222') },
    );

    expect(stderr()).toContain(
        'TESTPILOT_AZURE_OPENAI_ENDPOINT is still taken from .env.local, which ' +
            'overrides .testpilot/config.json',
    );
    expect(stderr()).toContain(
        'TESTPILOT_AZURE_OPENAI_API_KEY is still taken from the environment, which ' +
            'overrides .env.local',
    );
    for (const value of ['old-host', 'new-host', 'sk-shell-1111', 'sk-new-2222']) {
        expect(stdout() + stderr()).not.toContain(value);
    }
});

test('a --save file testpilot does not read is written, with a warning', async () => {
    await mkdir('sub');
    process.chdir('sub');

    await configSetAzureOpenAICommand(
        { save: '.env', promptApiKey: true },
        { isInteractive: () => true, readSecret: () => Promise.resolve('sk-sub-3333') },
    );

    expect(await readFile('.env', 'utf8')).toContain('sk-sub-3333');
    expect(stderr()).toContain(
        'testpilot does not read sub/.env (only .env and .env.local at the ' +
            'project root); load it into the environment yourself',
    );
    expect(stdout() + stderr()).not.toContain('sk-sub-3333');
});

test('a bare --save writes the values to .env.local at the project root', async () => {
    await mkdir('sub');
    process.chdir('sub');
    await configSetAzureOpenAICommand({ modelName: 'gpt-5.5', save: '' });
    expect(await readFile('../.env.local', 'utf8')).toBe(
        'TESTPILOT_AZURE_MODEL_NAME=gpt-5.5\n',
    );
});

test('--prompt-api-key without a terminal exits 2 and writes nothing', async () => {
    await expect(
        configSetAzureOpenAICommand(
            { promptApiKey: true, endpoint: 'https://x/' },
            { isInteractive: () => false },
        ),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync('.testpilot/config.json')).toBe(false);
    expect(stderr()).toContain(
        '--prompt-api-key needs an interactive terminal; ' +
            'run this command in your own terminal',
    );
});

test('an empty key exits 2 and writes nothing', async () => {
    await expect(
        configSetAzureOpenAICommand(
            { promptApiKey: true, endpoint: 'https://x/' },
            { isInteractive: () => true, readSecret: () => Promise.resolve('  ') },
        ),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync('.testpilot/config.json')).toBe(false);
    expect(existsSync('.env.local')).toBe(false);
});

test('an unreadable config.json exits 2 and nothing is written', async () => {
    await writeConfig('{ not json');
    await expect(
        configSetAzureOpenAICommand({ endpoint: 'https://x/', save: '' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(await readFile('.testpilot/config.json', 'utf8')).toBe('{ not json');
    expect(existsSync('.env.local')).toBe(false);
    expect(stderr()).toContain('.testpilot/config.json');
});

test('a value a dotenv file cannot hold exits 2 and nothing is written', async () => {
    await expect(
        configSetAzureOpenAICommand({ endpoint: 'say "it\'s"', save: '' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync('.testpilot/config.json')).toBe(false);
    expect(existsSync('.env.local')).toBe(false);
    expect(stderr()).toContain('TESTPILOT_AZURE_OPENAI_ENDPOINT');
    expect(stderr()).not.toContain("it's");
});

test('an unwritable dotenv target exits 2 before config.json is touched', async () => {
    await mkdir('a-directory');
    await expect(
        configSetAzureOpenAICommand({ endpoint: 'https://x/', save: 'a-directory' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync('.testpilot/config.json')).toBe(false);
    expect(stderr()).toContain('a-directory');
});

test.skipIf(process.getuid?.() === 0)(
    'a dotenv file that cannot be written exits 2 before config.json is touched',
    async () => {
        await writeFile('.env.local', 'APP_SECRET=keep\n', { mode: 0o400 });
        await expect(
            configSetAzureOpenAICommand({ endpoint: 'https://x/', save: '' }),
        ).rejects.toMatchObject({ exitCode: 2 });
        expect(existsSync('.testpilot/config.json')).toBe(false);
        expect(await readFile('.env.local', 'utf8')).toBe('APP_SECRET=keep\n');
    },
);

test('no flags at all exits 2', async () => {
    await expect(configSetAzureOpenAICommand({})).rejects.toMatchObject({
        exitCode: 2,
    });
    expect(stderr()).toContain(
        'Nothing to set: give at least one of --endpoint, --model-name, ' +
            '--deployment-name, --api-version or --prompt-api-key',
    );
});

test('the command is registered with its options', async () => {
    expect(
        await runCli([
            'config',
            'set-azure-openai',
            '--endpoint=https://x/',
            '--api-version=v1',
            '--save=dotenv:e.env',
        ]),
    ).toBe(0);
    expect(await readFile('e.env', 'utf8')).toBe(
        'TESTPILOT_AZURE_OPENAI_ENDPOINT=https://x/\nTESTPILOT_OPENAI_API_VERSION=v1\n',
    );
});

/** A stand-in for a terminal's stdin: an emitter with the methods the reader calls. */
function fakeTerminal(): {
    input: NodeJS.ReadStream;
    emitter: EventEmitter;
    setRawMode: ReturnType<typeof vi.fn>;
    written: string[];
} {
    const emitter = new EventEmitter();
    const setRawMode = vi.fn();
    const written: string[] = [];
    const input = Object.assign(emitter, {
        setRawMode,
        setEncoding: vi.fn(),
        resume: vi.fn(),
        pause: vi.fn(),
    }) as unknown as NodeJS.ReadStream;
    return { input, emitter, setRawMode, written };
}

/** Read with `readHiddenInput`, feeding `chunks`; the terminal is returned too. */
function readFrom(...chunks: string[]): {
    result: Promise<string>;
    terminal: ReturnType<typeof fakeTerminal>;
} {
    const terminal = fakeTerminal();
    const result = readHiddenInput('Key: ', terminal.input, {
        write: (text: string) => terminal.written.push(text),
    });
    for (const chunk of chunks) {
        terminal.emitter.emit('data', chunk);
    }
    return { result, terminal };
}

/** Raw mode was turned on, then off, and nothing is listening any more. */
function expectRestored(terminal: ReturnType<typeof fakeTerminal>): void {
    expect(terminal.setRawMode.mock.calls).toEqual([[true], [false]]);
    for (const event of ['data', 'end', 'error']) {
        expect(terminal.emitter.listenerCount(event)).toBe(0);
    }
}

test('readHiddenInput returns what was typed at Enter, echoing nothing', async () => {
    const { result, terminal } = readFrom('sk-', 'ab\x7fc\r');
    expect(await result).toBe('sk-ac');
    expectRestored(terminal);
    expect(terminal.written.join('')).toBe('Key: \n');
});

test('readHiddenInput ignores arrow keys and other escape sequences', async () => {
    const { result, terminal } = readFrom('a\x1b[Db\x1b[1;5Cc\x1bOAd\x1bxe\x1b', '\r');
    expect(await result).toBe('abcde');
    expectRestored(terminal);
});

test('readHiddenInput rejects on Ctrl+C with exit 2', async () => {
    const { result, terminal } = readFrom('abc\x03');
    await expect(result).rejects.toMatchObject({ exitCode: 2 });
    expectRestored(terminal);
});

test('readHiddenInput restores the terminal when input ends or fails', async () => {
    const ended = readFrom('ab');
    ended.terminal.emitter.emit('end');
    expect(await ended.result).toBe('ab');
    expectRestored(ended.terminal);

    const failed = readFrom();
    failed.terminal.emitter.emit('error', new Error('boom'));
    await expect(failed.result).rejects.toThrow('boom');
    expectRestored(failed.terminal);
});
