import { glob, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from 'vitest';

import { buildProgram } from '../../src/cli/cli.ts';
import { SETTINGS } from '../../src/config.ts';
import { ERROR_CODES } from '../../src/error-codes.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** Read a file of the bundled skill, e.g. `references/test-case-format.md`. */
async function readSkillFile(relative: string): Promise<string> {
    const text = await readFile(
        path.join(ROOT, 'skills', 'testpilot', relative),
        'utf8',
    );
    return text.replaceAll('\r\n', '\n');
}

const TEST_CASE = /^# .+\n\nurls = (\[.*\])\n\n## Steps\n\n(?:\d+\. .+\n?)+$/;

test('the template has the shape of the examples', async () => {
    const doc = await readSkillFile('references/test-case-format.md');
    const template = /```markdown\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    const files: string[] = [];
    for await (const file of glob('examples/**/*.md', { cwd: ROOT })) {
        files.push(file);
    }
    expect(files.length).toBeGreaterThan(0);
    const examples = await Promise.all(
        files.map(async (file) =>
            (await readFile(path.join(ROOT, file), 'utf8')).replaceAll('\r\n', '\n'),
        ),
    );
    for (const text of [template, ...examples]) {
        const match = TEST_CASE.exec(text.trimEnd() + '\n');
        expect(match, text).not.toBeNull();
        expect(() => {
            JSON.parse(match?.[1] ?? '');
        }).not.toThrow();
    }
});

test('errors.md explains exactly the codes testpilot emits', async () => {
    const doc = await readSkillFile('references/errors.md');
    const documented = [...doc.matchAll(/^### `([A-Z_]+)`$/gm)].map((m) => m[1]);
    expect(documented).toEqual(Object.keys(ERROR_CODES));
    for (const [code, { exitCode, hint }] of Object.entries(ERROR_CODES)) {
        const section = doc.split(`### \`${code}\``)[1]?.split('\n### ')[0] ?? '';
        expect(section, code).toContain(`**Exit:** ${exitCode}`);
        expect(section, code).toContain(hint);
    }
});

test('SKILL.md is named after its folder and links every reference', async () => {
    const skill = await readSkillFile('SKILL.md');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    expect(front).toMatch(/^name: testpilot$/m);
    expect(front).toMatch(/^description: .{20,}/m);
    for (const file of await readdir(path.join(ROOT, 'skills/testpilot/references'))) {
        expect(skill).toContain(`references/${file}`);
    }
});

test('commands.md covers every command and points to --help for flags', async () => {
    const doc = await readSkillFile('references/commands.md');
    const names = buildProgram().commands.flatMap((command) =>
        command.commands.length > 0
            ? command.commands.map((sub) => `${command.name()} ${sub.name()}`)
            : [command.name()],
    );
    for (const name of names) {
        expect(doc).toContain(`testpilot ${name}`);
    }
    expect(doc).toContain('--help');
});

test('configuration.md names every setting variable', async () => {
    const doc = await readSkillFile('references/configuration.md');
    for (const { variable } of SETTINGS) {
        expect(doc).toContain(variable);
    }
});
