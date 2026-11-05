#!/usr/bin/env node
/** CLI entrypoint wiring. */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command, CommanderError } from 'commander';

import { configureLogging, loadSettings, type Settings } from './config.ts';
import { errorMessage, ValidatorError } from './exceptions.ts';
import type { StepResult } from './extractor/agent.ts';
import { PlaywrightMCP, playwrightServer } from './extractor/mcp/server.ts';
import { Extractor } from './extractor/service.ts';
import { Generator } from './generator/service.ts';
import { getLlmProvider } from './llm/factory.ts';
import type { LLMProvider } from './llm/protocol.ts';
import { logger } from './logger.ts';
import {
    type Module,
    placeStatements,
    type StepRef,
    type StepStatement,
    type TestCase,
} from './model/test-case.ts';
import { Structurer } from './structurer/service.ts';
import { BrowserError, ValidationBrowser } from './validator/browser.ts';
import { Validator } from './validator/service.ts';
import { failureAt, type StepFailure } from './validator/utils.ts';

/** Ends the CLI with `exitCode`, after the failure has been logged. */
export class CliExit extends Error {
    override name = 'CliExit';
    readonly exitCode: number;

    /**
     * Initialize with the process exit code.
     *
     * @param exitCode - The status the process should exit with.
     * @param options - The failure that ended the run, as `cause`.
     */
    constructor(exitCode: number, options?: ErrorOptions) {
        super(`exit ${exitCode}`, options);
        this.exitCode = exitCode;
    }
}

/**
 * Run the full pipeline on a markdown test case and persist its output.
 *
 * Writes the validated test case JSON and the generated script to
 * `output/<parent folder>/<stem>.{json,spec.ts}`.
 *
 * @param markdownPath - The test case specification.
 * @throws {CliExit} If the configuration is invalid or a stage fails.
 */
export async function run(markdownPath: string): Promise<void> {
    const settings = loadSettingsOrFail();
    logger.info(
        `Running pipeline on ${markdownPath} (provider=${settings.llmProvider})`,
    );

    try {
        const llm = getLlmProvider(settings);
        const structurer = new Structurer(llm);
        const testCase = await structurer.run(await readFile(markdownPath, 'utf8'));

        const { result, runTimeMs } = await runStages(testCase, llm, settings);
        logger.info(`Extracted and validated ${result.modules.length} module(s)`);

        const outputDir = path.join(
            'output',
            path.basename(path.dirname(markdownPath)),
        );
        const stem = path.basename(markdownPath, path.extname(markdownPath));
        await mkdir(outputDir, { recursive: true });
        const jsonPath = path.join(outputDir, `${stem}.json`);
        await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        logger.info(`Wrote validated test case to ${jsonPath}`);

        const generator = new Generator(llm, settings.browserLocale);
        const script = await generator.run(result, runTimeMs);

        const scriptPath = path.join(outputDir, `${stem}.spec.ts`);
        await writeFile(scriptPath, script, 'utf8');
        logger.info(`Wrote generated script to ${scriptPath}`);
    } catch (error) {
        logFail(errorMessage(error), error, true);
    }
}

/** Re-extractions a run may spend, whatever triggered them. */
export const MAX_RETRIES = 5;

/** The stages `extractAndValidate` drives. */
export interface Stages {
    extractor: Pick<Extractor, 'runStep'>;
    validator: Pick<Validator, 'validate' | 'judge'>;
    mcp: Pick<PlaywrightMCP, 'reset' | 'run' | 'page'>;
}

/** Open the agent's and the replay browser, and extract and validate in them. */
async function runStages(
    testCase: TestCase,
    llm: LLMProvider,
    settings: Settings,
): Promise<{ result: TestCase; runTimeMs: number }> {
    await using mcp = await PlaywrightMCP.connect(
        playwrightServer(settings.browserLocale),
    );
    await using browser = await ValidationBrowser.launch({
        locale: settings.browserLocale,
    });
    // Awaited here, or the browsers would close before the run ends.
    return await extractAndValidate(testCase, {
        extractor: new Extractor(llm, mcp, settings.mcpMaxTurns),
        validator: new Validator(llm, browser),
        mcp,
    });
}

/**
 * Extract every step, then replay the whole script until it passes.
 *
 * A failure (or a step the judge still rejects) sends only that step back to
 * the agent, with feedback, from its browser restored to the state before
 * the step. Every re-extraction spends one of `MAX_RETRIES`.
 *
 * @returns The validated test case, and how long its replay took.
 * @throws {ValidatorError} If the retries run out.
 */
export function extractAndValidate(
    testCase: TestCase,
    stages: Stages,
): Promise<{ result: TestCase; runTimeMs: number }> {
    return new ExtractionRun(testCase, stages).execute();
}

/** One run of `extractAndValidate`: the test case so far, and the retries left. */
class ExtractionRun {
    private readonly stages: Stages;
    private working: TestCase;
    private retries = MAX_RETRIES;

    constructor(testCase: TestCase, stages: Stages) {
        this.stages = stages;
        this.working = testCase;
    }

    async execute(): Promise<{ result: TestCase; runTimeMs: number }> {
        for (const ref of this.refs()) {
            const { statements, rejection } = await this.extract(ref);
            if (rejection === undefined) {
                this.store(ref, statements);
            } else {
                await this.redo(ref, rejection);
            }
        }

        for (;;) {
            const validation = await this.stages.validator.validate(this.working);
            this.working = validation.testCase;
            if (validation.ok) {
                return { result: this.working, runTimeMs: validation.runTimeMs };
            }
            const { ref, feedback } = validation.failure;
            logger.warning(
                `Validation failed at step ${JSON.stringify(this.text(ref))}`,
            );
            await this.redo(ref, feedback);
        }
    }

    /** Have the agent perform a step from where its browser is, judging each report. */
    private extract(ref: StepRef, feedback?: string): Promise<StepResult> {
        const step = this.text(ref);
        const history = placeStatements(this.working, ref).map(
            ({ statement }) => statement.code,
        );
        return this.stages.extractor.runStep(this.module(ref), ref.step, {
            history,
            ...(feedback === undefined ? {} : { feedback }),
            check: async (statements) => {
                const verdict = await this.stages.validator.judge(
                    step,
                    statements,
                    await this.stages.mcp.page(),
                );
                return verdict.isValid
                    ? { statements: verdict.statements }
                    : { statements, rejection: verdict.feedback };
            },
        });
    }

    /**
     * Re-extract a step with feedback until the judge accepts it; a restore
     * that breaks at an earlier step re-extracts that step first.
     *
     * @throws {ValidatorError} If the retries run out.
     */
    private async redo(ref: StepRef, feedback: string): Promise<void> {
        for (;;) {
            if (this.retries === 0) {
                throw new ValidatorError(
                    `Step ${JSON.stringify(this.text(ref))} still failing, and ` +
                        `the run's ${MAX_RETRIES} retries are spent. Last ` +
                        `failure:\n${feedback}`,
                );
            }
            const broken = await this.restore(ref);
            if (broken !== undefined) {
                logger.warning(
                    `Restoring the browser failed at step ${JSON.stringify(this.text(broken.ref))}`,
                );
                await this.redo(broken.ref, broken.feedback);
                continue;
            }
            this.retries--;
            logger.info(
                `Re-extracting step ${JSON.stringify(this.text(ref))} ` +
                    `(retry ${MAX_RETRIES - this.retries}/${MAX_RETRIES})`,
            );
            const { statements, rejection } = await this.extract(ref, feedback);
            if (rejection === undefined) {
                this.store(ref, statements);
                return;
            }
            feedback = rejection;
        }
    }

    /**
     * Bring the agent's browser to the state before `ref`, by running the
     * earlier steps' statements in a fresh session.
     *
     * @returns The earlier step whose code failed, if one did.
     */
    private async restore(ref: StepRef): Promise<StepFailure | undefined> {
        await this.stages.mcp.reset();
        const prefix = placeStatements(this.working, ref);
        if (prefix.length === 0) {
            return undefined;
        }
        try {
            await this.stages.mcp.run(prefix.map(({ statement }) => statement));
        } catch (error) {
            if (!(error instanceof BrowserError)) {
                throw error;
            }
            return failureAt(
                prefix,
                error,
                'This statement failed when the pipeline re-ran the accepted ' +
                    'code to restore the browser for a later step:',
            );
        }
        return undefined;
    }

    /** Every step, in run order. */
    private refs(): StepRef[] {
        return this.working.modules.flatMap((module, moduleIndex) =>
            module.execution_steps.map((_, step) => ({ module: moduleIndex, step })),
        );
    }

    private module(ref: StepRef): Module {
        const module = this.working.modules[ref.module];
        if (module === undefined) {
            throw new RangeError(`The test case has no module ${ref.module}`);
        }
        return module;
    }

    private text(ref: StepRef): string {
        const step = this.module(ref).execution_steps[ref.step];
        if (step === undefined) {
            throw new RangeError(`Module ${ref.module} has no step ${ref.step}`);
        }
        return step.step;
    }

    /** Replace a step's statements. */
    private store(ref: StepRef, statements: StepStatement[]): void {
        this.working = {
            ...this.working,
            modules: this.working.modules.map((module, moduleIndex) =>
                moduleIndex !== ref.module
                    ? module
                    : {
                          ...module,
                          execution_steps: module.execution_steps.map((step, index) =>
                              index === ref.step ? { ...step, statements } : step,
                          ),
                      },
            ),
        };
    }
}

/**
 * Load settings from the environment, exiting with a clear error if invalid.
 *
 * @throws {CliExit} If the configuration is invalid.
 */
export function loadSettingsOrFail(): Settings {
    let settings: Settings;
    try {
        settings = loadSettings();
    } catch (error) {
        configureLogging();
        logFail(`Invalid configuration: ${errorMessage(error)}`, error, false);
    }
    configureLogging(settings);
    return settings;
}

/** Log `error` as a single clear error and end with a non-zero status. */
function logFail(message: string, error: unknown, traceback = false): never {
    if (traceback) {
        logger.error(message, error);
    } else {
        logger.error(message);
    }
    throw new CliExit(1, { cause: error });
}

/**
 * Parse `argv` and run the CLI.
 *
 * @param argv - The arguments after the executable and script names.
 * @returns The process exit status.
 */
export async function runCli(argv: string[]): Promise<number> {
    const program = new Command()
        .name('testpilot')
        .description(
            'Run the full pipeline on a markdown test case and persist its output.\n\n' +
                'Writes the validated test case JSON and the generated script to ' +
                'output/<parent folder>/<stem>.{json,spec.ts}.',
        )
        .argument('<markdown_path>', 'the markdown test case specification')
        .exitOverride()
        .action(async (markdownPath: string) => {
            const info = await stat(markdownPath).catch(() => undefined);
            if (!info?.isFile()) {
                program.error(
                    `error: invalid value for '<markdown_path>': ` +
                        `file ${JSON.stringify(markdownPath)} does not exist.`,
                    { exitCode: 2 },
                );
            }
            await run(markdownPath);
        });

    try {
        await program.parseAsync(argv, { from: 'user' });
        return 0;
    } catch (error) {
        if (error instanceof CliExit || error instanceof CommanderError) {
            return error.exitCode;
        }
        throw error;
    }
}

if (import.meta.main) {
    process.exitCode = await runCli(process.argv.slice(2));
}
