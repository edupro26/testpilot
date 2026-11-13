/** The skill testpilot bundles for AI agents, and where it is installed. */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { toPosix } from '../config.ts';
import { errorMessage } from '../runtime/exceptions.ts';
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

/** What {@link installSkill} did. */
export interface SkillInstall {
    status: 'installed' | 'updated';
    /** The replaced copy, if it could not be deleted once the new one was in. */
    leftover?: string;
}

/**
 * Copy the skill to `destination`, replacing any copy already there, so files
 * the source no longer has are gone from the copy.
 *
 * The skill is copied first and swapped in once whole, so a copy that fails (a
 * full disk, a file that cannot be read) leaves the installed one as it was.
 * The copy and the replaced folder are kept in the agent's folder, above its
 * skills folder, so a leftover is never loaded as a second skill.
 *
 * @param destination - The `testpilot` skill folder to write.
 * @param source - The folder to copy; the bundled skill by default.
 * @returns Whether there was a copy, and the replaced one if it is still there.
 * @throws {NodeJS.ErrnoException} What kept the skill from being copied or
 *   swapped in.
 */
export async function installSkill(
    destination: string,
    source: string = SKILL_SOURCE,
): Promise<SkillInstall> {
    const existed = existsSync(destination);
    const staging = path.dirname(path.dirname(destination));
    const copy = path.join(staging, `.testpilot-${randomUUID()}.new`);
    const old = path.join(staging, `.testpilot-${randomUUID()}.old`);
    try {
        await cp(source, copy, { recursive: true });
        await mkdir(path.dirname(destination), { recursive: true });
        if (existed) {
            await rename(destination, old);
        }
        try {
            await rename(copy, destination);
        } catch (error) {
            if (existed) {
                await rename(old, destination);
            }
            throw error;
        }
    } catch (error) {
        // A leftover partial copy is harmless; the error that matters is this one.
        await rm(copy, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
    const status = existed ? 'updated' : 'installed';
    try {
        await rm(old, { recursive: true, force: true });
    } catch {
        // The new copy is in; a file held open (on Windows) only delays the cleanup.
        return { status, leftover: old };
    }
    return { status };
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
 *   the same, else an "is outdated" warning with the command that updates it,
 *   or a "cannot be read" warning if it cannot be compared. Nothing if no copy
 *   is installed.
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
            let same: boolean;
            try {
                same = await sameSkill(destination, source);
            } catch (error) {
                checks.push({
                    name: 'Skill',
                    status: 'warn',
                    detail: `${shown} cannot be read: ${errorMessage(error)}`,
                    fix:
                        "check the folder's permissions, or replace it: " +
                        initSkillCommand(target),
                });
                continue;
            }
            checks.push(
                same
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
