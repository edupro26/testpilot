/**
 * Generator service: have the LLM assemble a validated test case into a script.
 *
 * The validated statements and the settings (locale, and a test timeout fitted
 * to how long the statements took to replay) are injected into the prompt and
 * must come back unchanged; the LLM writes everything around them, and writes
 * each late assertion's measured timeout into its matcher's options.
 */

import { GeneratorError } from '../exceptions.ts';
import type { LLMProvider } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import { statement, type TestCase } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import {
    describeSteps,
    localeSetting,
    missingLines,
    stripFence,
    syntaxDiagnostics,
    timeoutSetting,
} from './utils.ts';

const SYSTEM_PROMPT = 'You are an expert QA automation engineer.';

/** Assembles a validated TestCase into an executable script. */
export class Generator {
    private readonly llm: LLMProvider;
    private readonly locale: string;

    /**
     * Initialize with the LLM provider to use.
     *
     * @param llm - Writes the script around the validated statements.
     * @param locale - The context locale the statements were validated under,
     *   pinned in the generated script so it reproduces.
     */
    constructor(llm: LLMProvider, locale = 'en-US') {
        this.llm = llm;
        this.locale = locale;
    }

    /**
     * Assemble `testCase` into an executable Playwright Test spec.
     *
     * @param testCase - The fully validated test case.
     * @param runTimeMs - How long its statements took to replay back to back,
     *   which sets the test's timeout when Playwright's default is too short.
     * @returns The generated script source.
     * @throws {GeneratorError} If the test case carries no statements, or the
     *   LLM's script does not compile or drops or alters a validated statement
     *   or a setting.
     */
    async run(testCase: TestCase, runTimeMs = 0): Promise<string> {
        const steps = testCase.modules.flatMap((module) => module.execution_steps);
        const statements = steps.flatMap((step) => step.statements);
        if (statements.length === 0) {
            throw new GeneratorError(
                `${JSON.stringify(testCase.name)} has no validated statements to assemble`,
            );
        }

        logger.info(
            `Assembling script for ${JSON.stringify(testCase.name)} ` +
                `(${statements.length} statement(s))`,
        );

        const setting = localeSetting(this.locale);
        const timeout = timeoutSetting(runTimeMs);
        if (timeout !== undefined) {
            logger.info(
                `Statements replayed in ${(runTimeMs / 1000).toFixed(1)}s: ${timeout}`,
            );
        }
        const response = await this.llm.complete({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: renderPrompt('generator', {
                test_case_name: testCase.name,
                locale_setting: setting,
                timeout_setting: timeout ?? '(none)',
                steps: describeSteps(steps),
            }),
        });
        const script = `${stripFence(response).trim()}\n`;

        const syntaxErrors = syntaxDiagnostics(script);
        if (syntaxErrors.length > 0) {
            throw new GeneratorError(
                `Generated script does not compile: ${syntaxErrors.join('; ')}`,
            );
        }

        const required = [setting, ...(timeout === undefined ? [] : [timeout])].map(
            (code) => statement(code),
        );
        const missing = missingLines(script, [...required, ...statements]);
        if (missing.length > 0) {
            throw new GeneratorError(
                'Generated script dropped or altered validated code:\n' +
                    missing.map((line) => `  ${line}`).join('\n'),
            );
        }

        logger.info(`Assembled ${script.length} char(s) of script`);
        return script;
    }
}
