/** Tests for the init command: setting a project up for testpilot. */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, expect, type MockInstance, test, vi } from 'vitest';

import type { Check } from '../../src/cli/doctor.ts';
import { initCommand, readTestDir } from '../../src/cli/init.ts';
import { loadSettings } from '../../src/config.ts';

const CHECK_NAMES = [
    'Node.js',
    'Chromium',
    'Project Playwright',
    'Playwright config',
    'LLM settings',
];

/** Checks that all pass, except those named in `failing`. */
function checks(...failing: string[]): () => Promise<Check[]> {
    return () =>
        Promise.resolve(
            CHECK_NAMES.map((name) =>
                failing.includes(name)
                    ? { name, status: 'fail', detail: 'broken', fix: 'fix it' }
                    : { name, status: 'ok', detail: 'fine' },
            ),
        );
}

/** A project whose Playwright config holds `configText`. */
async function project(
    configText = "export default { testDir: './e2e' };",
): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
    await writeFile(path.join(cwd, 'playwright.config.ts'), configText);
    return cwd;
}

function readConfig(cwd: string): Promise<string> {
    return readFile(path.join(cwd, '.testpilot', 'config.json'), 'utf8');
}

let stdout: MockInstance<typeof process.stdout.write>;

/** Everything init printed. */
function printed(): string {
    return stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
}

beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    return () => {
        stdout.mockRestore();
    };
});

test('readTestDir reads a literal and nothing else', () => {
    expect(readTestDir("testDir: './tests',")).toBe('./tests');
    expect(readTestDir('testDir: "e2e"')).toBe('e2e');
    expect(readTestDir('testDir: `specs`')).toBe('specs');
    expect(readTestDir('export default defineConfig({})')).toBeUndefined();
    expect(readTestDir("testDir: path.join(__dirname, 'e2e')")).toBeUndefined();
    expect(readTestDir('testDir: `${root}/e2e`')).toBeUndefined();
});

test('readTestDir skips comments but not URLs', () => {
    expect(readTestDir("// testDir: './old',\ntestDir: './e2e'")).toBe('./e2e');
    expect(readTestDir("/* testDir: 'x' */ testDir: 'y'")).toBe('y');
    expect(readTestDir("use: { baseURL: 'http://a' }, testDir: 'z'")).toBe('z');
});

test('init writes the scripts folder and the .gitignore, nothing else', async () => {
    const cwd = await project();

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({ scriptsDir: 'e2e/testpilot' });
    expect(await readConfig(cwd)).toBe('{\n    "scriptsDir": "e2e/testpilot"\n}\n');
    expect(await readFile(path.join(cwd, '.testpilot', '.gitignore'), 'utf8')).toBe(
        'logs/\ntests/\n.playwright-mcp/\n',
    );
    expect((await readdir(path.join(cwd, '.testpilot'))).sort()).toEqual([
        '.gitignore',
        'config.json',
    ]);
    expect(loadSettings({}, cwd).scriptsDir).toBe('e2e/testpilot');
    expect(printed()).toContain('created .testpilot/config.json');
    expect(printed()).toContain('created .testpilot/.gitignore');
});

test('re-running init keeps an edited config', async () => {
    const cwd = await project();
    await initCommand({ cwd, checks: checks() });
    const edited = '{\n  "scriptsDir": "custom",\n  "maxTurns": 7\n}\n';
    await writeFile(path.join(cwd, '.testpilot', 'config.json'), edited);
    stdout.mockClear();

    await initCommand({ cwd, checks: checks() });

    expect(await readConfig(cwd)).toBe(edited);
    expect(printed()).not.toContain('.testpilot/config.json');
    expect(printed()).not.toContain('.testpilot/.gitignore');
});

test('an existing config without scriptsDir gets it added', async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, '.testpilot'));
    await writeFile(
        path.join(cwd, '.testpilot', 'config.json'),
        JSON.stringify({
            llmProvider: 'azure_openai',
            azureOpenAI: { endpoint: 'https://e' },
        }),
    );

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({
        llmProvider: 'azure_openai',
        azureOpenAI: { endpoint: 'https://e' },
        scriptsDir: 'e2e/testpilot',
    });
    expect(printed()).toContain('updated .testpilot/config.json');
});

test('a config that is not valid JSON is left for the developer to fix', async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, '.testpilot'));
    await writeFile(path.join(cwd, '.testpilot', 'config.json'), '{ not json');

    await initCommand({ cwd, checks: checks('LLM settings') });

    expect(await readConfig(cwd)).toBe('{ not json');
    expect(printed()).toMatch(
        /! \.testpilot\/config\.json: .*not valid JSON.*fix it by hand/,
    );
});

test('a config that is JSON but not an object is left as is, not crashed on', async () => {
    for (const text of ['null', '[1, 2]', '"abc"']) {
        const cwd = await project();
        await mkdir(path.join(cwd, '.testpilot'));
        await writeFile(path.join(cwd, '.testpilot', 'config.json'), text);

        await initCommand({ cwd, checks: checks('LLM settings') });

        expect(await readConfig(cwd)).toBe(text);
        expect(printed()).toContain(
            '! .testpilot/config.json: not a JSON object; fix it by hand',
        );
    }
});

test('a failed setup check stops init before writing anything', async () => {
    const cwd = await project();

    await expect(
        initCommand({ cwd, checks: checks('Project Playwright') }),
    ).rejects.toMatchObject({ exitCode: 2 });

    expect(existsSync(path.join(cwd, '.testpilot'))).toBe(false);
    expect(printed()).toContain('✖ Project Playwright');
});

test('missing LLM settings do not stop init', async () => {
    const cwd = await project();

    await initCommand({ cwd, checks: checks('LLM settings') });

    expect(existsSync(path.join(cwd, '.testpilot', 'config.json'))).toBe(true);
    expect(printed()).not.toContain('Next:');
});

test('without a literal testDir the scripts go to testpilot/', async () => {
    const computed = await project(
        "export default { testDir: path.join(__dirname, 'e2e') };",
    );
    await initCommand({ cwd: computed, checks: checks() });
    expect(JSON.parse(await readConfig(computed))).toEqual({ scriptsDir: 'testpilot' });
    expect(printed()).toContain('! Could not read testDir from playwright.config.ts');

    const unset = await project('export default {};');
    await initCommand({ cwd: unset, checks: checks() });
    expect(JSON.parse(await readConfig(unset))).toEqual({ scriptsDir: 'testpilot' });
});
