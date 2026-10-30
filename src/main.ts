#!/usr/bin/env node
/** CLI entrypoint wiring. */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command, CommanderError } from 'commander';

import { configureLogging, loadSettings, type Settings } from './config.ts';
import { errorMessage, ValidatorError } from './exceptions.ts';
import { PlaywrightMCP, playwrightServer } from './extractor/mcp/server.ts';
import { Extractor } from './extractor/service.ts';
import { toExecutionSteps } from './extractor/utils.ts';
import { Generator } from './generator/service.ts';
import { getLlmProvider } from './llm/factory.ts';
import type { LLMProvider } from './llm/protocol.ts';
import { logger } from './logger.ts';
import type { Module, StepStatement, TestCase } from './model/test-case.ts';
import { Structurer } from './structurer/service.ts';
import { ValidationBrowser } from './validator/browser.ts';
import { Validator } from './validator/service.ts';

/** What the retry loop needs from the validation browser. */
type ResettableBrowser = Pick<ValidationBrowser, 'reset' | 'run'> & {
    readonly page: { url(): string };
};

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

        const result = await extractAndValidate(testCase, llm, settings);
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
        const script = await generator.run(result);

        const scriptPath = path.join(outputDir, `${stem}.spec.ts`);
        await writeFile(scriptPath, script, 'utf8');
        logger.info(`Wrote generated script to ${scriptPath}`);
    } catch (error) {
        logFail(errorMessage(error), error, true);
    }
}

/**
 * Extract and validate every module, sharing one MCP and one validation browser.
 *
 * @param testCase - The structured test case.
 * @param llm - The LLM provider.
 * @param settings - Application settings, for the locale and MCP_MAX_TURNS.
 * @returns The test case with every step's statements filled in and proven.
 * @throws {ValidatorError} If a step still fails validation after one retry.
 */
async function extractAndValidate(
    testCase: TestCase,
    llm: LLMProvider,
    settings: Settings,
): Promise<TestCase> {
    await using mcp = await PlaywrightMCP.connect(
        playwrightServer(settings.browserLocale),
    );
    await using browser = await ValidationBrowser.launch({
        locale: settings.browserLocale,
    });

    const extractor = new Extractor(llm, mcp, settings.mcpMaxTurns);
    const validator = new Validator(llm, browser);
    const history: string[] = [];
    const modules: Module[] = [];
    for (const module of testCase.modules) {
        modules.push(
            await extractModule(module, extractor, validator, mcp, browser, history),
        );
    }
    return { name: testCase.name, modules };
}

/**
 * Drive one module's steps, validating each before the next begins.
 *
 * @param module - The module to process.
 * @param extractor - Drives the live browser per step.
 * @param validator - Replays and judges each step.
 * @param mcp - The live MCP connection, reset before a retry.
 * @param browser - The validation browser, whose URL a reset MCP returns to.
 * @param history - Accepted statements so far, extended in place so later
 *   modules know what the browser is already showing.
 * @returns The module with every step's statements filled in.
 * @throws {ValidatorError} If a step still fails validation after one retry.
 */
async function extractModule(
    module: Module,
    extractor: Extractor,
    validator: Validator,
    mcp: PlaywrightMCP,
    browser: ValidationBrowser,
    history: string[],
): Promise<Module> {
    const statementsByStep: StepStatement[][] = [];
    for (let index = 0; index < module.execution_steps.length; index++) {
        const statements = await extractStep(
            module,
            index,
            extractor,
            validator,
            mcp,
            browser,
            history,
        );
        statementsByStep.push(statements);
        history.push(...statements.map((statement) => statement.code));
    }

    return {
        url: module.url,
        description: module.description,
        execution_steps: toExecutionSteps(module, statementsByStep),
    };
}

/**
 * Extract and validate one step, retrying once with feedback.
 *
 * Both browsers are reset before the retry. The MCP browser only gets the
 * URL back, so the agent is told to redo the setup it needs, unreported.
 *
 * @throws {ValidatorError} If the step still fails after the retry.
 */
export async function extractStep(
    module: Module,
    index: number,
    extractor: Pick<Extractor, 'runStep'>,
    validator: Pick<Validator, 'run'>,
    mcp: Pick<PlaywrightMCP, 'reset' | 'callTool'>,
    browser: ResettableBrowser,
    history: string[],
): Promise<StepStatement[]> {
    const step = module.execution_steps[index];
    if (step === undefined) {
        throw new RangeError(`Module ${module.url} has no step ${index}`);
    }
    let statements = await extractor.runStep(module, index, { history });
    let verdict = await validator.run(step.step, statements);
    if (verdict.isValid) {
        return verdict.statements;
    }

    logger.warning(
        `Step ${JSON.stringify(step.step)} rejected, retrying with feedback`,
    );
    const url = await resetBrowsers(mcp, browser, module, history);
    statements = await extractor.runStep(module, index, {
        history,
        feedback: verdict.feedback,
        resetTo: url,
    });
    verdict = await validator.run(step.step, statements);
    if (!verdict.isValid) {
        throw new ValidatorError(
            `Step ${JSON.stringify(step.step)} failed validation after retry:\n` +
                verdict.feedback,
        );
    }
    return verdict.statements;
}

/**
 * Put both browsers back to a clean pre-step state before a retry.
 *
 * The validation browser re-runs the validated prefix; the MCP browser is
 * reconnected and sent to the validation browser's URL.
 *
 * @returns The URL the MCP browser was sent to.
 */
async function resetBrowsers(
    mcp: Pick<PlaywrightMCP, 'reset' | 'callTool'>,
    browser: ResettableBrowser,
    module: Module,
    history: string[],
): Promise<string> {
    await browser.reset();
    if (history.length > 0) {
        await browser.run(history.map((code) => ({ code, reason: '' })));
    }

    let url = browser.page.url();
    if (url === '' || url === 'about:blank') {
        url = module.url;
    }
    await mcp.reset();
    await mcp.callTool('browser_navigate', { url });
    logger.info(`Both browsers reset to ${url} for the retry`);
    return url;
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
