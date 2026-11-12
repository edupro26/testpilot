/** Tests for src/config. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
    findProjectRoot,
    loadSettings,
    readConfigObject,
    resolveSettings,
} from '../src/config.ts';
import { ApiKeyInConfigError, ConfigurationError } from '../src/runtime/exceptions.ts';

/** A fresh project folder, with the given `.testpilot/config.json` and dotenv files. */
async function project(
    files: {
        config?: unknown;
        env?: string;
        envLocal?: string;
        packageJson?: boolean;
    } = {},
): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
    if (files.packageJson === true) {
        await writeFile(path.join(root, 'package.json'), '{}');
    }
    if (files.config !== undefined) {
        await mkdir(path.join(root, '.testpilot'));
        await writeFile(
            path.join(root, '.testpilot', 'config.json'),
            typeof files.config === 'string'
                ? files.config
                : JSON.stringify(files.config),
        );
    }
    if (files.env !== undefined) {
        await writeFile(path.join(root, '.env'), files.env);
    }
    if (files.envLocal !== undefined) {
        await writeFile(path.join(root, '.env.local'), files.envLocal);
    }
    return root;
}

test('defaults apply when there is no config file and no variable', async () => {
    expect(loadSettings({}, await project())).toMatchObject({
        llmProvider: 'azure_openai',
        browserLocale: 'en-US',
        mcpMaxTurns: 25,
        logLevel: 'INFO',
        scriptsDir: 'testpilot',
    });
});

test('config.json is read, nested Azure block included', async () => {
    const root = await project({
        config: {
            llmProvider: 'azure_openai',
            azureOpenAI: {
                endpoint: 'https://e',
                modelName: 'm',
                deploymentName: 'd',
                apiVersion: 'v',
            },
            scriptsDir: 'e2e/testpilot',
            maxTurns: 15,
            locale: 'pt-PT',
            logLevel: 'debug',
        },
    });

    expect(loadSettings({}, root)).toMatchObject({
        llmProvider: 'azure_openai',
        azureOpenaiEndpoint: 'https://e',
        azureModelName: 'm',
        azureDeploymentName: 'd',
        openaiApiVersion: 'v',
        scriptsDir: 'e2e/testpilot',
        mcpMaxTurns: 15,
        browserLocale: 'pt-PT',
        logLevel: 'DEBUG',
    });
});

test('config.json < .env < .env.local < environment', async () => {
    const root = await project({
        config: { maxTurns: 10 },
        env: 'TESTPILOT_MAX_TURNS=11\n',
        envLocal: 'TESTPILOT_MAX_TURNS=12\n',
    });

    expect(loadSettings({}, root).mcpMaxTurns).toBe(12);
    expect(loadSettings({ TESTPILOT_MAX_TURNS: '13' }, root).mcpMaxTurns).toBe(13);
    await rm(path.join(root, '.env.local'));
    expect(loadSettings({}, root).mcpMaxTurns).toBe(11);
    await rm(path.join(root, '.env'));
    expect(loadSettings({}, root).mcpMaxTurns).toBe(10);
});

test('variable names are case-insensitive', async () => {
    expect(loadSettings({ testpilot_locale: 'fr-FR' }, await project())).toMatchObject({
        browserLocale: 'fr-FR',
    });
});

test('unprefixed variables belong to the webapp and are ignored', async () => {
    const root = await project({
        env: 'AZURE_OPENAI_API_KEY=webapp-key\nLOG_LEVEL=debug\nLLM_PROVIDER=mock\n',
    });

    expect(loadSettings({ LLM_PROVIDER: 'mock' }, root)).toMatchObject({
        llmProvider: 'azure_openai',
        azureOpenaiApiKey: undefined,
        logLevel: 'INFO',
    });
});

test('the API key is read from the environment only', async () => {
    const root = await project({ config: { azureOpenAI: { apiKey: 'sk-x' } } });

    expect(() => loadSettings({}, root)).toThrow(ConfigurationError);
    expect(() => loadSettings({}, root)).toThrow(/TESTPILOT_AZURE_OPENAI_API_KEY/);
});

test('a broken config.json is a ConfigurationError naming file and key', async () => {
    for (const [config, pattern] of [
        ['{ not json', /config\.json/],
        [{ maxTurn: 5 }, /maxTurn/],
        [{ maxTurns: 'many' }, /maxTurns/],
    ] as const) {
        const root = await project({ config });
        expect(() => loadSettings({}, root)).toThrow(ConfigurationError);
        expect(() => loadSettings({}, root)).toThrow(pattern);
    }
});

test('a JSON syntax error never quotes the file, so a key cannot leak', async () => {
    const root = await project({
        config: '{\n    "azureOpenAI": { "apiKey": sk-SECRET123 }\n}',
    });

    const error = (() => {
        try {
            loadSettings({}, root);
        } catch (caught) {
            return caught;
        }
        return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(String(error)).toMatch(/config\.json: not valid JSON/);
    expect(String(error)).not.toContain('SECRET');
});

test('an unreadable dotenv file is a ConfigurationError naming it', async () => {
    const root = await project();
    await mkdir(path.join(root, '.env'));

    expect(() => loadSettings({}, root)).toThrow(ConfigurationError);
    expect(() => loadSettings({}, root)).toThrow(/\.env/);
});

test('a variable after one set to blanks is still read', async () => {
    // parseEnv reads `KEY= ` as taking the next line for its value.
    const root = await project({
        env: 'DATABASE_URL= \nTESTPILOT_MAX_TURNS=7\n',
        envLocal: 'OTHER=\t\r\nTESTPILOT_SCRIPTS_DIR=e2e\r\n',
    });

    const settings = loadSettings({}, root);

    expect(settings.mcpMaxTurns).toBe(7);
    expect(settings.scriptsDir).toBe('e2e');
});

test('files saved with a byte order mark are read', async () => {
    // As Notepad and Windows PowerShell 5.1 save UTF-8.
    const root = await project({
        config: '\uFEFF{"maxTurns": 9}',
        env: '\uFEFFTESTPILOT_SCRIPTS_DIR=e2e\n',
    });

    const settings = loadSettings({}, root);

    expect(settings.mcpMaxTurns).toBe(9);
    expect(settings.scriptsDir).toBe('e2e');
    expect(
        await readConfigObject(path.join(root, '.testpilot', 'config.json')),
    ).toEqual({ maxTurns: 9 });
});

test('an invalid variable is a ConfigurationError naming it', async () => {
    const root = await project();

    expect(() => loadSettings({ TESTPILOT_MAX_TURNS: 'many' }, root)).toThrow(
        /TESTPILOT_MAX_TURNS/,
    );
    expect(() =>
        loadSettings({ TESTPILOT_LLM_PROVIDER: 'not-a-real-provider' }, root),
    ).toThrow(ConfigurationError);
    // The mock is a test double, not a provider a run can select.
    expect(() => loadSettings({ TESTPILOT_LLM_PROVIDER: 'mock' }, root)).toThrow(
        ConfigurationError,
    );
    // Chromium would only reject it once the browsers launch.
    expect(() => loadSettings({ TESTPILOT_LOCALE: 'not a locale' }, root)).toThrow(
        /TESTPILOT_LOCALE/,
    );
});

test('the project root is the nearest folder with a package.json', async () => {
    const root = await project({ packageJson: true });
    const nested = path.join(root, 'src', 'pages');
    await mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
    const bare = await project();
    expect(findProjectRoot(bare)).toBe(bare); // (tmpdir has no package.json)
});

test('each value names its source', async () => {
    const root = await project({
        config: { locale: 'pt-PT' },
        env: 'TESTPILOT_MAX_TURNS=10',
        envLocal: 'TESTPILOT_LOG_LEVEL=debug',
    });
    const { sources } = resolveSettings({ TESTPILOT_AZURE_OPENAI_API_KEY: 'k' }, root);
    expect(sources).toMatchObject({
        TESTPILOT_LOCALE: 'config.json',
        TESTPILOT_MAX_TURNS: '.env',
        TESTPILOT_LOG_LEVEL: '.env.local',
        TESTPILOT_AZURE_OPENAI_API_KEY: 'environment',
        TESTPILOT_SCRIPTS_DIR: 'default',
    });
    expect(sources.TESTPILOT_AZURE_OPENAI_ENDPOINT).toBeUndefined();
});

test('flags beat every other source and name themselves when invalid', async () => {
    const root = await project({ envLocal: 'TESTPILOT_MAX_TURNS=10' });
    const { settings, sources } = resolveSettings({ TESTPILOT_MAX_TURNS: '12' }, root, {
        TESTPILOT_MAX_TURNS: '3',
    });
    expect(settings.mcpMaxTurns).toBe(3);
    expect(sources.TESTPILOT_MAX_TURNS).toBe('flag');
    expect(() => resolveSettings({}, root, { TESTPILOT_MAX_TURNS: '0' })).toThrow(
        /--max-turns \(from flag\)/,
    );
    expect(() => resolveSettings({}, root, { TESTPILOT_MAX_TURNS: '0' })).toThrow(
        expect.objectContaining({ source: 'flag' }),
    );
});

test('an invalid value names the file it came from', async () => {
    const root = await project({ envLocal: 'TESTPILOT_MAX_TURNS=abc' });
    expect(() => loadSettings({}, root)).toThrow(
        expect.objectContaining({
            source: '.env.local',
            message: expect.stringContaining(
                'TESTPILOT_MAX_TURNS (from .env.local)',
            ) as unknown,
        }),
    );
    expect(() => loadSettings({ TESTPILOT_MAX_TURNS: '0' }, root)).toThrow(
        expect.objectContaining({ source: 'environment' }),
    );
});

test.each(['apiKey', 'azureOpenAIApiKey', 'TESTPILOT_AZURE_OPENAI_API_KEY', 'api-key'])(
    'an API key named %s in config.json is refused as an API key',
    async (name) => {
        const root = await project({ config: { azureOpenAI: { [name]: 'secret' } } });
        expect(() => loadSettings({}, root)).toThrow(ApiKeyInConfigError);
    },
);

test('readConfigObject returns the object, or undefined with no file', async () => {
    const root = await project({ config: { locale: 'pt-PT' } });
    const file = path.join(root, '.testpilot', 'config.json');
    expect(await readConfigObject(file)).toEqual({ locale: 'pt-PT' });
    expect(await readConfigObject(path.join(root, 'absent.json'))).toBeUndefined();
});

test.each([
    ['{ not json', 'not valid JSON'],
    ['[1]', 'not a JSON object'],
    ['null', 'not a JSON object'],
])('readConfigObject rejects %s', async (text, reason) => {
    const root = await project({ config: text });
    await expect(
        readConfigObject(path.join(root, '.testpilot', 'config.json')),
    ).rejects.toMatchObject({
        name: 'ConfigurationError',
        source: 'config.json',
        message: expect.stringContaining(reason) as unknown,
    });
});

test('readConfigObject drops a JSON syntax error, which quotes the file', async () => {
    const root = await project({
        config: '{ "azureOpenAI": { "apiKey": sk-SECRET1 } }',
    });
    const error: unknown = await readConfigObject(
        path.join(root, '.testpilot', 'config.json'),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain('SECRET');
});

test.each([
    ['TESTPILOT_SCRIPTS_DIR', '--out'],
    ['TESTPILOT_LOCALE', '--locale'],
] as const)('an empty %s is refused, naming its source', async (variable, flag) => {
    const root = await project();

    expect(() => resolveSettings({ [variable]: '' }, root)).toThrow(
        expect.objectContaining({
            source: 'environment',
            message: expect.stringContaining(
                `${variable} (from environment)`,
            ) as unknown,
        }),
    );
    expect(() => resolveSettings({}, root, { [variable]: '' })).toThrow(
        expect.objectContaining({
            source: 'flag',
            message: expect.stringContaining(`${flag} (from flag)`) as unknown,
        }),
    );
});
