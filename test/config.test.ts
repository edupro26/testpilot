/** Tests for src/config. */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { loadSettings } from '../src/config.ts';
import { ConfigurationError } from '../src/exceptions.ts';

test('settings come from the environment, then .env, then the defaults', async () => {
    // Names are case-insensitive, and the environment wins over the file.
    const envFile = path.join(await mkdtemp(path.join(tmpdir(), 'testpilot-')), '.env');
    await writeFile(envFile, 'llm_provider=azure_openai\nBROWSER_LOCALE=pt-PT\n');

    expect(loadSettings({}, 'no-such.env')).toMatchObject({
        llmProvider: 'mock',
        browserLocale: 'en-US',
        mcpMaxTurns: 25,
        logLevel: 'INFO',
    });
    expect(loadSettings({ BROWSER_LOCALE: 'fr-FR' }, envFile)).toMatchObject({
        llmProvider: 'azure_openai',
        browserLocale: 'fr-FR',
    });
    expect(
        loadSettings({ MCP_MAX_TURNS: '7', LOG_LEVEL: 'debug' }, 'no-such.env'),
    ).toMatchObject({ mcpMaxTurns: 7, logLevel: 'DEBUG' });
});

test('an invalid value is a ConfigurationError naming the setting', () => {
    expect(() =>
        loadSettings({ LLM_PROVIDER: 'not-a-real-provider' }, 'no-such.env'),
    ).toThrow(ConfigurationError);
    expect(() => loadSettings({ MCP_MAX_TURNS: 'many' }, 'no-such.env')).toThrow(
        /MCP_MAX_TURNS/,
    );
});
