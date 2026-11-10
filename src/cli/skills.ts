/** The skill testpilot bundles for AI agents, and where it is installed. */

import { existsSync } from 'node:fs';
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Check } from './doctor.ts';

/** The agents `init --skills` installs for: the shared folder or one agent's own. */
export type SkillAgent = 'agents' | 'copilot' | 'claude';

/** Every {@link SkillAgent}, the default first. */
export const SKILL_AGENTS: readonly SkillAgent[] = ['agents', 'copilot', 'claude'];

/** The bundled skill, in the testpilot clone. */
export const SKILL_SOURCE = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'skills',
    'testpilot',
);

/**
 * One place the skill is installed: an agent's folder, in the project or the
 * user's home.
 */
export interface SkillTarget {
    agent: SkillAgent;
    /** The user's home folder rather than the project. */
    global: boolean;
}

/** Each agent's skills folder, relative to the project root and to the home folder. */
const SKILLS_FOLDER: Record<SkillAgent, { project: string; home: string }> = {
    agents: { project: '.agents/skills', home: '.agents/skills' },
    copilot: { project: '.github/skills', home: '.copilot/skills' },
    claude: { project: '.claude/skills', home: '.claude/skills' },
};

/**
 * The folder the skill is installed in.
 *
 * @param target - The agent and whether it is the user's copy.
 * @param places - The project root and the user's home folder.
 * @returns The `testpilot` skill folder.
 */
export function skillDir(
    target: SkillTarget,
    places: { cwd: string; home: string },
): string {
    const folder = SKILLS_FOLDER[target.agent];
    return target.global
        ? path.join(places.home, folder.home, 'testpilot')
        : path.join(places.cwd, folder.project, 'testpilot');
}

/**
 * Copy the skill to `destination`, replacing any copy already there, so files
 * the source no longer has are gone from the copy.
 *
 * @param destination - The `testpilot` skill folder to write.
 * @param source - The folder to copy; the bundled skill by default.
 * @returns `'updated'` if there was a copy, else `'installed'`.
 */
export async function installSkill(
    destination: string,
    source: string = SKILL_SOURCE,
): Promise<'installed' | 'updated'> {
    const existed = existsSync(destination);
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true });
    return existed ? 'updated' : 'installed';
}

/**
 * The `init` command that installs the skill at a target.
 *
 * @param target - The agent and whether it is the user's copy.
 * @returns For example `testpilot init --skills=copilot -g`.
 */
export function initSkillCommand(target: SkillTarget): string {
    const agent = target.agent === 'agents' ? '' : `=${target.agent}`;
    return `testpilot init --skills${agent}${target.global ? ' -g' : ''}`;
}

/**
 * Whether the copy at `destination` is the same as the source: the same
 * relative file paths, with byte-equal contents.
 *
 * @param destination - The installed `testpilot` skill folder.
 * @param source - The folder to compare with; the bundled skill by default.
 * @returns `false` if a file differs, is missing or is extra.
 */
export async function sameSkill(
    destination: string,
    source: string = SKILL_SOURCE,
): Promise<boolean> {
    const [installed, bundled] = await Promise.all([
        skillFiles(destination),
        skillFiles(source),
    ]);
    if (installed.join('\n') !== bundled.join('\n')) {
        return false;
    }
    for (const file of bundled) {
        const [left, right] = await Promise.all([
            readFile(path.join(destination, file)),
            readFile(path.join(source, file)),
        ]);
        if (!left.equals(right)) {
            return false;
        }
    }
    return true;
}

/**
 * Check every installed copy of the skill against the bundled one.
 *
 * @param places - The project root and the user's home folder.
 * @param source - The folder to compare with; the bundled skill by default.
 * @returns One result per copy found, in the six targets' order: ok if it is
 *   the same, else an "is outdated" warning with the command that updates it.
 *   Nothing if no copy is installed.
 */
export async function checkSkills(
    places: { cwd: string; home: string },
    source: string = SKILL_SOURCE,
): Promise<Check[]> {
    const checks: Check[] = [];
    for (const global of [false, true]) {
        for (const agent of SKILL_AGENTS) {
            const target = { agent, global };
            const destination = skillDir(target, places);
            if (!existsSync(destination)) {
                continue;
            }
            const shown = shownSkillPath(target, places);
            checks.push(
                (await sameSkill(destination, source))
                    ? { name: 'Skill', status: 'ok', detail: shown }
                    : {
                          name: 'Skill',
                          status: 'warn',
                          detail: `${shown} is outdated`,
                          fix: initSkillCommand(target),
                      },
            );
        }
    }
    return checks;
}

/**
 * Where the skill is installed, as shown to the user.
 *
 * @param target - The agent and whether it is the user's copy.
 * @param places - The project root and the user's home folder.
 * @returns A POSIX path: relative to the project root, or starting with `~/`
 *   for the user's copy.
 */
export function shownSkillPath(
    target: SkillTarget,
    places: { cwd: string; home: string },
): string {
    const destination = skillDir(target, places);
    return target.global
        ? path.posix.join('~', toPosix(path.relative(places.home, destination)))
        : toPosix(path.relative(places.cwd, destination));
}

/** The files under `folder`, as sorted POSIX paths relative to it. */
async function skillFiles(folder: string): Promise<string[]> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) =>
            toPosix(path.relative(folder, path.join(entry.parentPath, entry.name))),
        )
        .sort();
}

/** A path with `/` separators, as shown to the user. */
function toPosix(file: string): string {
    return file.split(path.sep).join('/');
}
