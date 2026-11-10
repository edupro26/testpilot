/** `testpilot generate`: turn a markdown test case into a Playwright script. */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
 *   is invalid, the outputs belong to another input with the same name, or a
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
