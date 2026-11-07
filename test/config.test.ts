/** Tests for src/config. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { loadSettings } from '../src/config.ts';
import { ConfigurationError } from '../src/runtime/exceptions.ts';

/** A fresh project folder, with the given `.testpilot/config.json` and dotenv files. */
async function project(
    files: { config?: unknown; env?: string; envLocal?: string } = {},
): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
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
        scriptsDir: 'tests/testpilot',
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

test('a broken config.json is a ConfigurationError naming the file and key', async () => {
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
});
