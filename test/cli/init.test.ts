/** Tests for the init command: setting a project up for testpilot. */

import { existsSync } from 'node:fs';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, expect, type MockInstance, test, vi } from 'vitest';

import type { Check } from '../../src/cli/doctor.ts';
import { initCommand, readTestDirs, type TestDirs } from '../../src/cli/init.ts';
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

/** testpilot's own packages, which a test project borrows its Playwright from. */
const NODE_MODULES = path.resolve(import.meta.dirname, '../../node_modules');

/**
 * A project whose Playwright config holds `configText`, with Playwright
 * installed unless `playwright` is false.
 */
async function project(
    configText = "export default { testDir: './e2e' };",
    { playwright = true } = {},
): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
    await writeFile(path.join(cwd, 'playwright.config.ts'), configText);
    if (playwright) {
        await symlink(NODE_MODULES, path.join(cwd, 'node_modules'), 'junction');
    }
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

/** The folders Playwright resolves for a config holding `configText`. */
async function testDirs(configText: string): Promise<{ cwd: string; dirs: TestDirs }> {
    const cwd = await project(configText);
    return {
        cwd,
        dirs: await readTestDirs(cwd, path.join(cwd, 'playwright.config.ts')),
    };
}

test('readTestDirs resolves testDir however the config sets it', async () => {
    for (const configText of [
        "export default { testDir: './e2e' };",
        "import path from 'node:path';\n" +
            "export default { testDir: path.join(__dirname, 'e2e') };",
        "import { defineConfig as config } from '@playwright/test';\n" +
            "export default config({ testDir: 'e2e' });",
        "const dir = 'e2e';\nmodule.exports = { testDir: `./${dir}` };",
        // A config that prints, as dotenv does, leaves the report readable.
        "console.log('[dotenv] injecting env');\nexport default { testDir: 'e2e' };",
    ]) {
        const { cwd, dirs } = await testDirs(configText);
        expect(dirs).toEqual({
            rootDir: path.join(cwd, 'e2e'),
            projects: [path.join(cwd, 'e2e')],
        });
    }
}, 30_000);

test("readTestDirs keeps each project's testDir apart from the config's", async () => {
    const { cwd, dirs } = await testDirs(
        'export default {\n' +
            "  projects: [{ name: 'api', testDir: './api' }, { name: 'chromium' }],\n" +
            "  testDir: './e2e',\n" +
            '};',
    );

    expect(dirs).toEqual({
        rootDir: path.join(cwd, 'e2e'),
        projects: [path.join(cwd, 'api'), path.join(cwd, 'e2e')],
    });
});

test('readTestDirs fails with the reason Playwright gives', async () => {
    const cwd = await project("throw new Error('BASE_URL is not set');");

    await expect(
        readTestDirs(cwd, path.join(cwd, 'playwright.config.ts')),
    ).rejects.toThrow('Error: BASE_URL is not set');
});

test('readTestDirs fails without Playwright installed', async () => {
    const cwd = await project(undefined, { playwright: false });

    await expect(
        readTestDirs(cwd, path.join(cwd, 'playwright.config.ts')),
    ).rejects.toThrow('@playwright/test is not installed in this project');
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

test('an unloadable config is warned about; scripts go to testpilot/', async () => {
    const cwd = await project(
        "import { makeConfig } from './shared';\n" +
            "export default makeConfig({ testDir: './e2e' });",
    );

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({ scriptsDir: 'testpilot' });
    expect(printed()).toMatch(
        /! Could not read testDir from playwright\.config\.ts: .*shared/,
    );
    expect(printed()).toContain('; check scriptsDir in .testpilot/config.json');
});

test('without a testDir the scripts go to testpilot/, with no warning', async () => {
    const cwd = await project('export default {};');

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({ scriptsDir: 'testpilot' });
    expect(printed()).not.toContain('!');
});

test('a computed testDir is where the scripts go', async () => {
    const cwd = await project(
        "import path from 'node:path';\n" +
            "export default { testDir: path.join(__dirname, 'e2e', 'smoke') };",
    );

    await initCommand({ cwd, checks: checks() });

    expect(JSON.parse(await readConfig(cwd))).toEqual({
        scriptsDir: 'e2e/smoke/testpilot',
    });
    expect(printed()).not.toContain('!');
});

test("a project's testDir is not taken for the whole config's", async () => {
    // The API project comes first, but it is not where every project looks:
    // the scripts go to the top-level folder, and init says the projects differ.
    const cwd = await project(
        'export default {\n' +
            "  projects: [{ name: 'api', testDir: './api' }, { name: 'chromium' }],\n" +
            "  testDir: './e2e',\n" +
            '};',
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
        "export default { projects: [{ name: 'ui', testDir: './ui' }] };",
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
