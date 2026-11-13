/**
 * Generator service: have the LLM assemble a validated test case into a script.
 *
 * The validated statements and the settings (locale, and a test timeout fitted
 * to how long the statements took to replay) are injected into the prompt and
 * must come back unchanged; the LLM writes everything around them, and writes
 * each late assertion's measured timeout into its matcher's options.
 */

import { type LLMProvider, SYSTEM_PROMPT } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import { statement, type StepStatement, type TestCase } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import { GeneratorError } from '../runtime/exceptions.ts';
import {
    describeSteps,
    localeSetting,
    missingStatements,
    stripFence,
    syntaxDiagnostics,
    timeoutSetting,
} from './utils.ts';

// Scripts the LLM may write before the run fails: a rejected one is written
// again, told why, rather than losing the run that validated its statements.
const MAX_ATTEMPTS = 2;

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
                `${JSON.stringify(testCase.name)} has no validated statements ` +
                    'to assemble',
                { code: 'NO_STATEMENTS' },
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
        const prompt = renderPrompt('generator', {
            test_case_name: testCase.name,
            locale_setting: setting,
            timeout_setting: timeout ?? '(none)',
            steps: describeSteps(steps),
        });
        const required = [setting, ...(timeout === undefined ? [] : [timeout])].map(
            (code) => statement(code),
        );
        let feedback = '';
        for (let attempt = 1; ; attempt++) {
            const response = await this.llm.complete({
                systemPrompt: SYSTEM_PROMPT,
                userPrompt: prompt + feedback,
            });
            const script = `${stripFence(response).trim()}\n`;
            const problem = rejection(script, [...required, ...statements]);
            if (problem === undefined) {
                logger.info(`Assembled ${script.length} char(s) of script`);
                return script;
            }
            if (attempt === MAX_ATTEMPTS) {
                throw new GeneratorError(problem, { code: 'SCRIPT_ASSEMBLY_FAILED' });
            }
            logger.warning(`Script rejected, writing it again: ${problem}`);
            feedback =
                `\n\nYOUR PREVIOUS SCRIPT WAS REJECTED:\n${problem}\n` +
                'Write the whole script again, fixing that.\n';
        }
    }
}

/**
 * Why `script` cannot ship, if it cannot.
 *
 * @param script - The LLM's script.
 * @param required - The settings and validated statements it must contain, in
 *   order.
 * @returns The problem; `undefined` when the script compiles and writes every
 *   required statement unaltered.
 */
function rejection(script: string, required: StepStatement[]): string | undefined {
    const syntaxErrors = syntaxDiagnostics(script);
    if (syntaxErrors.length > 0) {
        return `Generated script does not compile: ${syntaxErrors.join('; ')}`;
    }
    const missing = missingStatements(script, required);
    if (missing.length > 0) {
        return (
            'Generated script dropped or altered validated code:\n' +
            missing.map((line) => `  ${line}`).join('\n')
        );
    }
    return undefined;
}
