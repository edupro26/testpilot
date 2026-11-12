/** `testpilot generate`: turn a markdown test case into a Playwright script. */

import { randomUUID } from 'node:crypto';
import {
    link,
    mkdir,
    readFile,
    rename,
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { CONFIG_DIR, findProjectRoot, type SettingFlags } from '../config.ts';
import { ERROR_CODES, type ErrorCode } from '../error-codes.ts';
import { lastLineAt, logger, setLogFile } from '../logger.ts';
import { errorMessage } from '../runtime/exceptions.ts';
import {
    type OutputPaths,
    outputPaths,
    outputSource,
    runPipeline,
    type RunProgress,
    type Stage,
} from '../runtime/pipeline.ts';
import {
    CliExit,
    errorCodeFor,
    failWithCode,
    loadSettingsOrFail,
    LogFolderError,
    OutputConflictError,
    UsageError,
} from './errors.ts';

/**
 * Where a run's log file goes.
 *
 * @param root - The project root.
 * @param stem - The input's name without its extension.
 * @param now - The run's start, in local time.
 * @param run - Which of the runs of `stem` that started in the same second
 *   this is; 1 by default.
 * @returns `<root>/.testpilot/logs/<YYYY-MM-DD_HH-MM-SS>-<stem>.log`, with
 *   `_<run>` after the time from the second run on.
 */
export function logFilePath(root: string, stem: string, now: Date, run = 1): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())];
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad);
    const start = `${date.join('-')}_${time.join('-')}${run === 1 ? '' : `_${run}`}`;
    return path.join(root, CONFIG_DIR, 'logs', `${start}-${stem}.log`);
}

/**
 * Create a run's log file, empty, under a name no other run has taken.
 *
 * @param root - The project root.
 * @param stem - The input's name without its extension.
 * @param now - The run's start, in local time.
 * @returns The file's path; see `logFilePath`.
 * @throws {NodeJS.ErrnoException} What kept the file from being created.
 */
async function createLogFile(root: string, stem: string, now: Date): Promise<string> {
    for (let run = 1; ; run++) {
        const file = logFilePath(root, stem, now, run);
        try {
            await writeFile(file, '', { flag: 'wx' });
            return file;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
    }
}

// How long a lock file that records no holder may be one being written, rather
// than one left behind by a run that stopped before it wrote it.
const LOCK_WRITE_MS = 5_000;

// How long a run waits before looking again at a stale lock that another run is
// taking over.
const TAKEOVER_POLL_MS = 50;

// How long a run waits for another run's takeover, which takes milliseconds,
// before it gives up: the guard may be one left by a run killed mid-takeover,
// whose pid a live process now has. Longer than `LOCK_WRITE_MS`, so that a
// guard its run left unwritten is cleared, not given up on.
const TAKEOVER_WAIT_MS = LOCK_WRITE_MS + 1_000;

// The codes `link` fails with where the file system has no hard links.
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

// The host this process runs on. A pid means nothing outside its host: two
// containers sharing a volume both run as pid 1.
const HOST = hostname();

// The lock and guard files this process holds, resolved. One that records this
// process but is not held here was left by an earlier process given the same
// pid, as each container's first process is.
const held = new Set<string>();

/** Who holds a reservation of a test case's outputs, as its lock file records it. */
interface OutputHolder {
    /** The holding run's process. */
    pid: number;
    /** The input it is generating, as the outputs' JSON records it. */
    source: string;
    /** The host it runs on; absent from locks written before hosts were recorded. */
    host?: string;
}

/**
 * Reserve a test case's outputs for this run, until the reservation is
 * disposed: another run, of this input or another with the same name, cannot
 * write them in the meantime.
 *
 * The reservation is a lock file next to the JSON, `<stem>.json.lock`, which
 * records the run's process, input and host. One left behind by a run that no
 * longer exists is taken over (see `takeOver`); one made on another host is
 * held, as its run cannot be checked from here.
 *
 * @param paths - The outputs.
 * @param source - The input, as the outputs' JSON records it.
 * @returns The reservation; dispose of it once both outputs are written.
 * @throws {OutputConflictError} If another run that is still going holds them,
 *   or one that has stopped left a lock that cannot be removed, or another
 *   run's takeover of it has not ended within `TAKEOVER_WAIT_MS`.
 * @throws {NodeJS.ErrnoException} What kept the lock file from being created
 *   or read.
 */
async function reserveOutputs(
    paths: OutputPaths,
    source: string,
): Promise<AsyncDisposable> {
    const lock = `${paths.testCase}.lock`;
    const holder: OutputHolder = { pid: process.pid, source, host: HOST };
    await mkdir(path.dirname(lock), { recursive: true });
    const deadline = Date.now() + TAKEOVER_WAIT_MS;
    for (;;) {
        try {
            await createWritten(lock, JSON.stringify(holder));
            held.add(path.resolve(lock));
            return {
                [Symbol.asyncDispose]: () =>
                    removeLock(lock)
                        .catch((error: unknown) => {
                            logger.warning(
                                `Cannot remove ${shown(lock)}; the next run will take ` +
                                    `it over: ${errorMessage(error)}`,
                            );
                        })
                        .finally(() => held.delete(path.resolve(lock))),
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
        const other = await lockHolder(lock);
        if (other !== 'stale') {
            const on =
                other?.host === undefined || other.host === HOST
                    ? ''
                    : ` on ${other.host}`;
            const by =
                other === undefined
                    ? 'another run'
                    : `${other.source} by another run (process ${other.pid}${on})`;
            throw new OutputConflictError(
                `${shown(paths.testCase)} is being generated from ${by}; generating ` +
                    `${source} now would overwrite it and its script. If no other ` +
                    `run is going, delete ${shown(lock)}`,
            );
        }
        let blocked: boolean;
        try {
            blocked = !(await takeOver(lock));
        } catch (error) {
            // Retrying would meet the same lock forever.
            throw new OutputConflictError(
                `${shown(paths.testCase)} is reserved by a run that has stopped, and ` +
                    `its lock cannot be removed: ${errorMessage(error)}. ` +
                    `Delete ${shown(lock)}`,
                { cause: error },
            );
        }
        if (blocked && Date.now() >= deadline) {
            throw new OutputConflictError(
                `${shown(paths.testCase)} is reserved by a run that has stopped, and ` +
                    'another run has been taking it over for ' +
                    `${TAKEOVER_WAIT_MS / 1000} s. If no other run is going, ` +
                    `delete ${shown(`${lock}.takeover`)}`,
            );
        }
    }
}

/**
 * Remove a stale lock, so that the caller can try to create its own.
 *
 * Only one run at a time does this, the one that creates the lock's guard,
 * `<lock>.takeover`; it removes the lock only if it is still stale. Without the
 * guard, two runs that found the same stale lock could both remove it, the
 * second removing the first's new lock, and both would go on to write the
 * outputs. A run that finds the guard taken waits, then looks at the lock
 * again; a guard whose run has stopped while taking over is cleared (see
 * `clearStaleGuard`). The guard is created already written, so it is never
 * judged by its age while its run is going, and it records an id of its own, so
 * that a run removes only its own guard.
 *
 * @param lock - The lock file, found stale.
 * @returns False if another run's guard kept this one from looking at the lock
 *   (it has waited `TAKEOVER_POLL_MS`), else true.
 * @throws {NodeJS.ErrnoException} What kept the guard from being created or
 *   removed, or the lock from being read or removed.
 */
async function takeOver(lock: string): Promise<boolean> {
    const guard = `${lock}.takeover`;
    const run = { pid: process.pid, host: HOST, id: randomUUID() };
    try {
        await createWritten(guard, JSON.stringify(run));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
        if (await clearStaleGuard(guard)) {
            return true;
        }
        await sleep(TAKEOVER_POLL_MS);
        return false;
    }
    held.add(path.resolve(guard));
    try {
        if ((await lockHolder(lock)) === 'stale') {
            await removeLock(lock);
        }
    } finally {
        held.delete(path.resolve(guard));
        const mine = await fileState(guard);
        if (mine?.text === JSON.stringify(run)) {
            await removeIfSame(guard, mine);
        }
    }
    return true;
}

/**
 * Create `file` holding `text`, unless it exists, so that no other run finds it
 * unwritten: the text goes to a draft of this run's own, which is then linked
 * into place. Where the file system has no hard links, or the draft cannot be
 * written, it is written in place.
 *
 * @throws {NodeJS.ErrnoException} With code `EEXIST` if `file` exists, or what
 *   kept it from being created.
 */
async function createWritten(file: string, text: string): Promise<void> {
    const draft = `${file}.${randomUUID()}`;
    try {
        await writeFile(draft, text, { flag: 'wx' });
    } catch {
        // Writing in place says whether `file` exists, which a folder this run
        // cannot write to does not stop.
        await writeFile(file, text, { flag: 'wx' });
        return;
    }
    try {
        await link(draft, file);
    } catch (error) {
        if (!NO_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) {
            throw error;
        }
        await writeFile(file, text, { flag: 'wx' });
    } finally {
        await removeLock(draft);
    }
}

/**
 * Remove a takeover guard whose run has stopped.
 *
 * The guard is judged by the run it records, not by its age, which a file
 * server's clock can skew; only one that records no run, as one left unwritten
 * does, is judged by its age. It is removed with `removeIfSame`.
 *
 * @param guard - The guard file, found taken.
 * @returns Whether it was stale and is now gone.
 * @throws {NodeJS.ErrnoException} What kept the guard from being moved or
 *   removed.
 */
async function clearStaleGuard(guard: string): Promise<boolean> {
    const judged = await fileState(guard);
    if (judged === undefined) {
        return true;
    }
    const run = guardRun(judged.text);
    const stale =
        run === undefined
            ? Date.now() - judged.mtimeMs >= LOCK_WRITE_MS
            : !isHolding(run.pid, guard, run.host);
    if (!stale) {
        return false;
    }
    await removeIfSame(guard, judged);
    return true;
}

/**
 * Remove `file` if it is still the one `judged` describes. It is moved aside
 * before it is removed, and put back if it turns out to be one another run
 * created meanwhile: removing it by name would remove that run's.
 *
 * @throws {NodeJS.ErrnoException} What kept the file from being moved or
 *   removed.
 */
async function removeIfSame(file: string, judged: FileState): Promise<void> {
    const aside = `${file}.${randomUUID()}`;
    try {
        await rename(file, aside);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
    const moved = await fileState(aside);
    if (
        moved !== undefined &&
        (moved.ino !== judged.ino ||
            moved.mtimeMs !== judged.mtimeMs ||
            moved.text !== judged.text)
    ) {
        // Another run's: put it back, unless a third run has created one since.
        await link(aside, file).catch(() => undefined);
    }
    await removeLock(aside);
}

/**
 * The run a takeover guard records: `{ pid, host, id }`, or a bare pid as guards
 * written before hosts were recorded hold; `undefined` if it is not written yet.
 */
function guardRun(text: string): { pid: number; host?: string } | undefined {
    let recorded: unknown;
    try {
        recorded = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (Number.isInteger(recorded)) {
        return { pid: recorded as number };
    }
    const { pid, host } = (recorded ?? {}) as { pid?: unknown; host?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid)) {
        return undefined;
    }
    return typeof host === 'string' ? { pid, host } : { pid };
}

/** A file's text, inode and modification time. */
interface FileState {
    text: string;
    ino: number;
    mtimeMs: number;
}

/** A file's state; `undefined` once it is gone. */
async function fileState(file: string): Promise<FileState | undefined> {
    try {
        const [text, { ino, mtimeMs }] = await Promise.all([
            readFile(file, 'utf8'),
            stat(file),
        ]);
        return { text, ino, mtimeMs };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/**
 * Delete a lock file; one already gone is not an error.
 *
 * @throws {NodeJS.ErrnoException} What kept the lock file from being deleted.
 */
async function removeLock(lock: string): Promise<void> {
    try {
        await unlink(lock);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

/**
 * The run holding a lock file.
 *
 * @param lock - The lock file.
 * @returns Its holder, if it is still running; `undefined` if the lock records
 *   none but may be being written; `'stale'` if it is gone, its holder has
 *   stopped, or it was left unwritten.
 * @throws {NodeJS.ErrnoException} If the lock exists but cannot be read.
 */
async function lockHolder(lock: string): Promise<OutputHolder | 'stale' | undefined> {
    let text: string;
    let modified: number;
    try {
        [text, { mtimeMs: modified }] = await Promise.all([
            readFile(lock, 'utf8'),
            stat(lock),
        ]);
    } catch (error) {
        // Gone: its holder released it. Any other failure says nothing of the
        // holder, so the lock is not taken over.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 'stale';
        }
        throw error;
    }
    let recorded: Partial<OutputHolder> = {};
    try {
        recorded = JSON.parse(text) as Partial<OutputHolder>;
    } catch {
        // Not written yet, or written in part.
    }
    if (typeof recorded.pid !== 'number' || typeof recorded.source !== 'string') {
        return Date.now() - modified < LOCK_WRITE_MS ? undefined : 'stale';
    }
    const host = typeof recorded.host === 'string' ? recorded.host : undefined;
    return isHolding(recorded.pid, lock, host)
        ? { pid: recorded.pid, source: recorded.source, ...(host && { host }) }
        : 'stale';
}

/**
 * Whether the run recorded in `file`, as process `pid` on `host`, still holds
 * it. This process holds only the files it created; the one that last had its
 * pid may have left others. A run on another host cannot be checked from here,
 * so it is taken to hold the file; a file that records no host is judged here.
 */
function isHolding(pid: number, file: string, host?: string): boolean {
    if (host !== undefined && host !== HOST) {
        return true;
    }
    return pid === process.pid ? held.has(path.resolve(file)) : isRunning(pid);
}

/** Whether the process `pid` exists. */
function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: it exists, under another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** The flags of `testpilot generate`, as commander parses them. */
export interface GenerateOptions {
    /** Show the browser the agent drives. */
    headed?: boolean;
    /** The scripts folder for this run, relative to the working directory. */
    out?: string;
    /** The maximum agent turns per step; validated with the settings. */
    maxTurns?: string;
    /** The browser locale. */
    locale?: string;
    /** The logging level. */
    logLevel?: string;
    /** Print the result as one JSON object on standard output. */
    json?: boolean;
}

/** What `generate --json` prints: one object, the only thing on stdout. */
export interface GenerateResult {
    status: 'success' | 'failure';
    /** The process exit status: 0 success, 1 failed to generate, 2 setup error. */
    exitCode: 0 | 1 | 2;
    /** The generated script, absolute; `null` unless it was written. */
    spec: string | null;
    /** The validated test case JSON, absolute; `null` unless it was written. */
    testCase: string | null;
    /**
     * The run's log, absolute; `null` if there is none: the run failed before
     * the log opened, or the log file could not be created.
     */
    log: string | null;
    error: {
        /** The stable error code, e.g. `STEP_OUT_OF_TURNS`; see `ERROR_CODES`. */
        code: ErrorCode;
        /** What to do about it: one or two sentences, fixed for the code. */
        hint: string;
        /** The error's class name, e.g. `ExtractorError`, `APIError`. */
        type: string;
        /** The stage that failed; `null` if the run failed before the first. */
        stage: Stage | null;
        /** The step being extracted, or whose replay failed; `null` if none. */
        step: string | null;
        message: string;
    } | null;
}

/** What a run has done so far, for reporting its outcome. */
interface RunRecord {
    progress: RunProgress;
    /** The log file, once it is open. */
    log: string | undefined;
    /** Where the outputs go, once known. */
    paths: OutputPaths | undefined;
}

/** The setting each flag overrides, for the flags given. */
function settingFlags(options: GenerateOptions): SettingFlags {
    const flags: SettingFlags = {};
    if (options.out !== undefined) {
        // Kept empty, to be refused: resolved, it would be the working directory.
        flags.TESTPILOT_SCRIPTS_DIR =
            options.out === '' ? '' : path.resolve(options.out);
    }
    if (options.maxTurns !== undefined) {
        flags.TESTPILOT_MAX_TURNS = options.maxTurns;
    }
    if (options.locale !== undefined) {
        flags.TESTPILOT_LOCALE = options.locale;
    }
    if (options.logLevel !== undefined) {
        flags.TESTPILOT_LOG_LEVEL = options.logLevel;
    }
    return flags;
}

/** What `generate --json` reports for a run that ended in `error`. */
function failureResult(error: unknown, run: RunRecord): GenerateResult {
    const exitCode = error instanceof CliExit && error.exitCode === 2 ? 2 : 1;
    // A CliExit carries the failure that ended the run, if there was one.
    const cause = error instanceof CliExit ? error.cause : error;
    const named = cause instanceof Error ? cause : undefined;
    const code = errorCodeFor(cause ?? error);
    const { stage, step } = run.progress;
    return {
        status: 'failure',
        exitCode,
        spec: null,
        // The JSON is written when validation ends, just before the generate stage.
        testCase: stage === 'generate' ? (run.paths?.testCase ?? null) : null,
        log: run.log ?? null,
        error: {
            code,
            hint: ERROR_CODES[code].hint,
            type:
                named?.constructor.name ??
                (cause === undefined ? 'UsageError' : 'Error'),
            stage: stage ?? null,
            step: step ?? null,
            message: cause === undefined ? errorMessage(error) : errorMessage(cause),
        },
    };
}

/** Print `value` as the one JSON object on standard output. */
function printJson(value: GenerateResult): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** How often the watchdog checks how long the run has been quiet, in ms. */
const WATCHDOG_TICK_MS = 5_000;

/** How long a run may go without a line on standard error, in ms. */
const QUIET_LIMIT_MS = 10_000;

/**
 * Log a line, whatever the log level, whenever the run has gone `QUIET_LIMIT_MS`
 * without one, so a long run never looks stuck: `Waiting for <stage> to
 * finish: step <i> of <n>, "<step>" (<s>s)` while a step is extracted, else
 * without the step number or the step, where `<s>` is the time since the last
 * line that was not the watchdog's. A line comes at most `QUIET_LIMIT_MS` plus
 * one tick (15 seconds) after the last.
 *
 * @param progress - The stage and step under way, named in the line.
 * @returns The timer; clear it when the run ends.
 */
function watchProgress(progress: RunProgress): NodeJS.Timeout {
    // The last line that was not the watchdog's own.
    let quietSince = lastLineAt();
    let ownLine: number | undefined;
    const timer = setInterval(() => {
        const last = lastLineAt();
        if (last !== ownLine) {
            quietSince = last;
        }
        const now = Date.now();
        if (now - last < QUIET_LIMIT_MS) {
            return;
        }
        const seconds = Math.round((now - quietSince) / 1000);
        logger.always(`${progressLine(progress)} (${seconds}s)`);
        ownLine = lastLineAt();
    }, WATCHDOG_TICK_MS);
    timer.unref();
    return timer;
}

/**
 * What the run is waiting for, as the watchdog says it.
 *
 * @param progress - The stage and step under way.
 * @returns For example `Waiting for extract to finish: step 6 of 14, "Log in"`.
 */
function progressLine(progress: RunProgress): string {
    const { stage, step, stepNumber, stepCount } = progress;
    const waiting = `Waiting for ${stage ?? 'the run'} to finish`;
    if (step === undefined) {
        return waiting;
    }
    const position =
        stepNumber === undefined || stepCount === undefined
            ? 'step'
            : `step ${stepNumber} of ${stepCount},`;
    return `${waiting}: ${position} ${JSON.stringify(step)}`;
}

/** Path of `file` relative to the working directory, as shown to the user. */
function shown(file: string): string {
    return path.relative(process.cwd(), file);
}

/**
 * Run the full pipeline on a markdown test case.
 *
 * The run's log is written to `.testpilot/logs/`; its path is the first and
 * the last line logged, success or failure, whatever the log level. A log file
 * that cannot be created is only a warning: the run goes on without one, and
 * reports no log. Results go to standard output: the three paths, or with
 * `--json` one JSON object (for success and failure alike); progress and logs
 * go to standard error, where a `Waiting for <stage> to finish` line, naming
 * the step and its number while one is extracted, comes whenever 10 to 15
 * seconds pass without one, whatever the log level.
 *
 * @param markdownPath - The test case specification, relative to the working
 *   directory.
 * @param options - The command's flags; each overrides its setting for this run.
 * @throws {CliExit} With status 2 if the file is missing, the configuration
 *   is invalid, the outputs belong to another input with the same name or
 *   another run is generating them, or a
 *   setup problem (see `exitCodeFor`) stops the run, or 1 if a pipeline stage
 *   fails.
 */
export async function generateCommand(
    markdownPath: string,
    options: GenerateOptions,
): Promise<void> {
    const run: RunRecord = {
        progress: { stage: undefined, step: undefined },
        log: undefined,
        paths: undefined,
    };
    let paths: OutputPaths;
    try {
        paths = await generate(markdownPath, options, run);
    } catch (error) {
        if (options.json) {
            printJson(failureResult(error, run));
        }
        throw error;
    }
    if (options.json) {
        printJson({
            status: 'success',
            exitCode: 0,
            ...paths,
            log: run.log ?? null,
            error: null,
        });
    } else {
        process.stdout.write(
            `spec: ${shown(paths.spec)}\ntest case: ${shown(paths.testCase)}\n` +
                `log: ${run.log === undefined ? '(none)' : shown(run.log)}\n`,
        );
    }
}

/** Run the command, recording in `run` how far it got; return where it wrote. */
async function generate(
    markdownPath: string,
    options: GenerateOptions,
    run: RunRecord,
): Promise<OutputPaths> {
    const input = path.resolve(markdownPath);
    const info = await stat(input).catch(() => undefined);
    if (!info?.isFile()) {
        const message =
            `invalid value for '<markdown_path>': ` +
            `file ${JSON.stringify(markdownPath)} does not exist.`;
        failWithCode(message, new UsageError(message));
    }
    const root = findProjectRoot();
    const settings = loadSettingsOrFail(settingFlags(options));
    const paths = outputPaths(input, root, settings.scriptsDir);
    const source = path.relative(root, input).split(path.sep).join(path.posix.sep);
    // Held until both outputs are written, so that no run of another input with
    // the same name passes the check below and writes them in the meantime.
    await using reservation = await reserveOutputs(paths, source).catch(
        (error: unknown) => {
            const message =
                error instanceof OutputConflictError
                    ? error.message
                    : `Cannot reserve ${shown(paths.testCase)}: ${errorMessage(error)}`;
            failWithCode(message, error);
        },
    );
    const owner = await outputSource(paths);
    if (owner !== undefined && owner !== source) {
        const message =
            `${shown(paths.testCase)} was generated from ${owner}; generating ` +
            `${source} would overwrite it and its script`;
        failWithCode(message, new OutputConflictError(message));
    }
    run.paths = paths;
    const stem = path.basename(input, path.extname(input));
    const now = new Date();
    const logDir = path.dirname(logFilePath(root, stem, now));

    try {
        await mkdir(logDir, { recursive: true });
    } catch (error) {
        const message =
            `Cannot create the log folder ${logDir}: ` + errorMessage(error);
        failWithCode(message, new LogFolderError(message, { cause: error }));
    }
    // Created before the run, so that a run reports a log only if it has one.
    try {
        run.log = await createLogFile(root, stem, now);
        setLogFile(run.log);
    } catch (error) {
        logger.warning(
            `Cannot create a log file in ${shown(logDir)}, so this run has none: ` +
                errorMessage(error),
        );
    }
    const logLine = run.log === undefined ? undefined : `Log: ${shown(run.log)}`;
    const watchdog = watchProgress(run.progress);
    try {
        if (logLine !== undefined) {
            logger.always(logLine);
        }
        await runPipeline(input, settings, {
            paths,
            source,
            root,
            headed: options.headed,
            progress: run.progress,
        });
    } catch (error) {
        failWithCode(errorMessage(error), error);
    } finally {
        clearInterval(watchdog);
        if (logLine !== undefined) {
            logger.always(logLine);
        }
        setLogFile(undefined);
    }
    return paths;
}
