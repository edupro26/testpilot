/** Tests for installing the bundled skill into a project or the user's home. */

import { existsSync } from 'node:fs';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, expect, test } from 'vitest';

import {
    checkSkills,
    initSkillCommand,
    installSkill,
    sameSkill,
    SKILL_AGENTS,
    SKILL_SOURCE,
    skillDir,
    type SkillTarget,
} from '../../src/cli/skills.ts';

let cwd: string;
let home: string;
let source: string;

beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'testpilot-'));
    home = await mkdtemp(path.join(tmpdir(), 'testpilot-home-'));
    source = await mkdtemp(path.join(tmpdir(), 'testpilot-skill-'));
    await mkdir(path.join(source, 'references'));
    await writeFile(path.join(source, 'SKILL.md'), '# skill');
    await writeFile(path.join(source, 'references', 'a.md'), 'a');
});

test.each([
    [{ agent: 'agents', global: false }, ['cwd', '.agents/skills/testpilot']],
    [{ agent: 'copilot', global: false }, ['cwd', '.github/skills/testpilot']],
    [{ agent: 'claude', global: false }, ['cwd', '.claude/skills/testpilot']],
    [{ agent: 'agents', global: true }, ['home', '.agents/skills/testpilot']],
    [{ agent: 'copilot', global: true }, ['home', '.copilot/skills/testpilot']],
    [{ agent: 'claude', global: true }, ['home', '.claude/skills/testpilot']],
])('%o installs under %o', (target, place) => {
    const [base, relative] = place as [string, string];
    const places = { cwd: '/work/app', home: '/home/dev' };
    expect(skillDir(target as SkillTarget, places)).toBe(
        path.join(base === 'cwd' ? places.cwd : places.home, relative),
    );
});

test('a re-install replaces the copy, dropping files the source lost', async () => {
    const destination = path.join(cwd, '.agents/skills/testpilot');
    expect(await installSkill(destination, source)).toBe('installed');
    await writeFile(path.join(destination, 'stale.md'), 'old');
    await rm(path.join(source, 'references', 'a.md'));
    expect(await installSkill(destination, source)).toBe('updated');
    expect(existsSync(path.join(destination, 'stale.md'))).toBe(false);
    expect(existsSync(path.join(destination, 'references', 'a.md'))).toBe(false);
    expect(existsSync(path.join(destination, 'SKILL.md'))).toBe(true);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an update that fails to copy keeps the installed copy',
    async () => {
        const destination = path.join(cwd, '.agents/skills/testpilot');
        await installSkill(destination, source);
        await writeFile(path.join(source, 'SKILL.md'), '# new skill');
        await chmod(path.join(source, 'references', 'a.md'), 0o000);
        try {
            await expect(installSkill(destination, source)).rejects.toThrow(/EACCES/);
        } finally {
            await chmod(path.join(source, 'references', 'a.md'), 0o644);
        }

        expect(await readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
            '# skill',
        );
        expect(existsSync(path.join(destination, 'references', 'a.md'))).toBe(true);
        expect(await readdir(path.dirname(destination))).toEqual(['testpilot']);
    },
);

test('the bundled skill is where SKILL_SOURCE points', () => {
    expect(existsSync(path.join(SKILL_SOURCE, 'SKILL.md'))).toBe(true);
});

test('every agent has a destination and an init command', () => {
    expect(SKILL_AGENTS).toEqual(['agents', 'copilot', 'claude']);
    expect(initSkillCommand({ agent: 'agents', global: false })).toBe(
        'testpilot init --skills',
    );
    expect(initSkillCommand({ agent: 'copilot', global: true })).toBe(
        'testpilot init --skills=copilot -g',
    );
    expect(initSkillCommand({ agent: 'claude', global: false })).toBe(
        'testpilot init --skills=claude',
    );
    expect(initSkillCommand({ agent: 'agents', global: true })).toBe(
        'testpilot init --skills -g',
    );
});

test('no installed copy, no check line', async () => {
    expect(await checkSkills({ cwd, home }, source)).toEqual([]);
});

test('a current project copy passes and a stale user copy warns with -g', async () => {
    await installSkill(
        skillDir({ agent: 'agents', global: false }, { cwd, home }),
        source,
    );
    const user = skillDir({ agent: 'copilot', global: true }, { cwd, home });
    await installSkill(user, source);
    await writeFile(path.join(user, 'SKILL.md'), 'edited');

    expect(await checkSkills({ cwd, home }, source)).toEqual([
        { name: 'Skill', status: 'ok', detail: '.agents/skills/testpilot' },
        {
            name: 'Skill',
            status: 'warn',
            detail: '~/.copilot/skills/testpilot is outdated',
            fix: 'testpilot init --skills=copilot -g',
        },
    ]);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a copy that cannot be read is a warning, not a crash',
    async () => {
        const dir = skillDir({ agent: 'agents', global: false }, { cwd, home });
        await installSkill(dir, source);
        await chmod(path.join(dir, 'references'), 0o000);
        try {
            expect(await checkSkills({ cwd, home }, source)).toEqual([
                {
                    name: 'Skill',
                    status: 'warn',
                    detail: expect.stringMatching(
                        /^\.agents\/skills\/testpilot cannot be read: EACCES/,
                    ) as unknown,
                    fix:
                        "check the folder's permissions, or replace it: " +
                        'testpilot init --skills',
                },
            ]);
        } finally {
            await chmod(path.join(dir, 'references'), 0o755);
        }
    },
);

test('an extra file in the copy makes it differ', async () => {
    const dir = skillDir({ agent: 'claude', global: false }, { cwd, home });
    await installSkill(dir, source);
    await writeFile(path.join(dir, 'extra.md'), 'x');
    expect(await sameSkill(dir, source)).toBe(false);
});

test('a copy missing a file differs, and an identical copy is the same', async () => {
    const dir = skillDir({ agent: 'claude', global: false }, { cwd, home });
    await installSkill(dir, source);
    expect(await sameSkill(dir, source)).toBe(true);
    await rm(path.join(dir, 'references', 'a.md'));
    expect(await sameSkill(dir, source)).toBe(false);
});
