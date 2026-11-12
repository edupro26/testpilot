/** Tests for the init command: setting a project up for testpilot. */

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, expect, type MockInstance, test, vi } from 'vitest';

import type { Check } from '../../src/cli/doctor.ts';
import { initCommand, readTestDirs } from '../../src/cli/init.ts';
import { checkSkills } from '../../src/cli/skills.ts';
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

/** The top-level `testDir` read from a config exporting `{ <properties> }`. */
function topTestDir(properties: string): string | null | undefined {
    return readTestDirs(`export default defineConfig({ ${properties} });`).testDir;
}

test('readTestDirs reads a literal and nothing else', () => {
    expect(topTestDir("testDir: './tests',")).toBe('./tests');
    expect(topTestDir('testDir: "e2e"')).toBe('e2e');
    expect(topTestDir('testDir: `specs`')).toBe('specs');
    expect(topTestDir('')).toBeUndefined();
    expect(topTestDir("testDir: path.join(__dirname, 'e2e')")).toBeNull();
    expect(topTestDir('testDir: `${root}/e2e`')).toBeNull();
    expect(topTestDir("testDir: './e2e' + '/smoke',")).toBeNull();
    expect(topTestDir("testDir: 'e2e'.concat('/smoke')")).toBeNull();
    expect(topTestDir("testDir: 'e2e' // the specs\n,")).toBe('e2e');
});

test('readTestDirs skips comments but not URLs', () => {
    expect(topTestDir("// testDir: './old',\ntestDir: './e2e'")).toBe('./e2e');
    expect(topTestDir("/* testDir: 'x' */ testDir: 'y'")).toBe('y');
    expect(topTestDir("use: { baseURL: 'http://a' }, testDir: 'z'")).toBe('z');
});

test('readTestDirs finds the config however it is exported', () => {
    for (const configText of [
        "export default { testDir: 'e2e' };",
        "export default { testDir: 'e2e' } satisfies PlaywrightTestConfig;",
        "const config = { testDir: 'e2e' };\nexport default config;",
        "module.exports = defineConfig({ testDir: 'e2e' });",
        "import { defineConfig as config } from '@playwright/test';\n" +
            "export default config({ testDir: 'e2e' });",
        "import * as pw from '@playwright/test';\n" +
            "export default pw.defineConfig({ testDir: 'e2e' });",
        "const { defineConfig: config } = require('@playwright/test');\n" +
            "module.exports = config({ testDir: 'e2e' });",
    ]) {
        expect(readTestDirs(configText).testDir).toBe('e2e');
    }
});

test('readTestDirs says it cannot read a config it cannot find', () => {
    for (const configText of [
        "export default makeConfig({ testDir: 'e2e' });",
        "export default defineConfig(base, { testDir: 'e2e' });",
        "export default require('./shared.config');",
    ]) {
        expect(readTestDirs(configText)).toEqual({ testDir: null, projects: [] });
    }
});

test("readTestDirs keeps a project's testDir apart from the top-level one", () => {
    const dirs = readTestDirs(
        'export default defineConfig({\n' +
            "  projects: [{ name: 'api', testDir: './api' }, { name: 'chromium' }],\n" +
            "  testDir: './e2e',\n" +
            '});',
    );

    expect(dirs).toEqual({ testDir: './e2e', projects: ['./api', undefined] });
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

test('JSON that is not an object in the config is left as is, no crash', async () => {
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

    stdout.mockClear();
    const joined = await project("export default { testDir: './e2e' + '/smoke' };");
    await initCommand({ cwd: joined, checks: checks() });
    expect(JSON.parse(await readConfig(joined))).toEqual({ scriptsDir: 'testpilot' });
    expect(printed()).toContain('! Could not read testDir from playwright.config.ts');

    stdout.mockClear();
    const unset = await project('export default {};');
    await initCommand({ cwd: unset, checks: checks() });
    expect(JSON.parse(await readConfig(unset))).toEqual({ scriptsDir: 'testpilot' });
    expect(printed()).not.toContain('Could not read testDir');
});

test('an aliased defineConfig is followed to its testDir', async () => {
    const cwd = await project(
        "import { defineConfig as config } from '@playwright/test';\n" +
            "export default config({ testDir: './e2e' });",
    );

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({ scriptsDir: 'e2e/testpilot' });
    expect(printed()).not.toContain('Could not read testDir');
});

test('a config whose object cannot be found is warned about, not taken as unset', async () => {
    const cwd = await project(
        "import { makeConfig } from './shared';\n" +
            "export default makeConfig({ testDir: './e2e' });",
    );

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({ scriptsDir: 'testpilot' });
    expect(printed()).toContain('! Could not read testDir from playwright.config.ts');
});

test("a project's testDir is not taken for the whole config's", async () => {
    // The API project comes first, but it is not where every project looks:
    // the scripts go to the top-level folder, and init says the projects differ.
    const cwd = await project(
        'export default defineConfig({\n' +
            "  projects: [{ name: 'api', testDir: './api' }, { name: 'chromium' }],\n" +
            "  testDir: './e2e',\n" +
            '});',
    );

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({ scriptsDir: 'e2e/testpilot' });
    expect(printed()).toContain(
        '! The projects in playwright.config.ts use different test folders ' +
            '(api, e2e)',
    );
});

test('the folder every project shares is where the scripts go', async () => {
    const cwd = await project(
        "export default defineConfig({ projects: [{ name: 'ui', testDir: './ui' }] });",
    );

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({ scriptsDir: 'ui/testpilot' });
    expect(printed()).not.toContain('!');
});

test('init --skills installs the skill even when a check fails', async () => {
    const cwd = await project();
    await expect(
        initCommand({ cwd, checks: checks('Playwright config'), skills: 'agents' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(existsSync(path.join(cwd, '.agents/skills/testpilot/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(cwd, '.testpilot'))).toBe(false);
    expect(printed()).toContain('installed .agents/skills/testpilot/');
});

test('init --skills installs the skill and sets up a passing project', async () => {
    const cwd = await project();
    await initCommand({ cwd, checks: checks(), skills: 'claude' });
    expect(existsSync(path.join(cwd, '.claude/skills/testpilot/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(cwd, '.testpilot', 'config.json'))).toBe(true);
    expect(printed()).toContain('installed .claude/skills/testpilot/');

    stdout.mockClear();
    await initCommand({ cwd, checks: checks(), skills: 'claude' });
    expect(printed()).toContain('updated .claude/skills/testpilot/');
});

test('init --skills installs before the checks, so they see the new copy', async () => {
    const cwd = await project();
    const home = await mkdtemp(path.join(tmpdir(), 'testpilot-home-'));
    const skill = path.join(cwd, '.agents/skills/testpilot');
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), 'edited');
    const passing = checks();

    await initCommand({
        cwd,
        home,
        checks: async () => [
            ...(await passing()),
            ...(await checkSkills({ cwd, home })),
        ],
        skills: 'agents',
    });

    // No warning to run the command that just ran: the check sees the new copy.
    expect(printed()).not.toContain('outdated');
    expect(printed()).toContain('Skill: .agents/skills/testpilot');
    expect(printed()).toContain('updated .agents/skills/testpilot/');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a skill folder that cannot be replaced exits 2 with the fix',
    async () => {
        const cwd = await project();
        const skills = path.join(cwd, '.agents/skills');
        await mkdir(path.join(skills, 'testpilot'), { recursive: true });
        await chmod(skills, 0o555);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await expect(
                initCommand({ cwd, checks: checks(), skills: 'agents' }),
            ).rejects.toMatchObject({ exitCode: 2 });
            expect(errors.mock.calls.join('\n')).toContain(
                'Cannot install the skill in .agents/skills/testpilot/: EACCES',
            );
            expect(existsSync(path.join(cwd, '.testpilot'))).toBe(false);
        } finally {
            errors.mockRestore();
            await chmod(skills, 0o755);
        }
    },
);

test('init --skills -g installs for the user only, outside any project', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
    const home = await mkdtemp(path.join(tmpdir(), 'testpilot-home-'));
    const checks = vi.fn();
    await initCommand({ cwd, home, checks, skills: 'copilot', global: true });
    expect(checks).not.toHaveBeenCalled();
    expect(existsSync(path.join(home, '.copilot/skills/testpilot/SKILL.md'))).toBe(
        true,
    );
    expect(existsSync(path.join(cwd, '.testpilot'))).toBe(false);
    expect(printed()).toContain('installed ~/.copilot/skills/testpilot/');
});
