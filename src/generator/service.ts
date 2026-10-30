/**
 * Generator service: have the LLM assemble a validated test case into a script.
 *
 * The validated statements and the locale setting are injected into the prompt
 * and must come back unchanged; the LLM writes everything around them.
 */

import ts from 'typescript';

import { GeneratorError } from '../exceptions.ts';
import type { LLMProvider } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import type { TestCase } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';

const SYSTEM_PROMPT = 'You are an expert QA automation engineer.';

/**
 * Pins the locale these locators were validated under, quoted the way
 * Playwright's codegen quotes the statements.
 */
function localeSetting(locale: string): string {
    return `test.use({ locale: '${locale}' });`;
}

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
     * @returns The generated script source.
     * @throws {GeneratorError} If the test case carries no statements, or the
     *   LLM's script does not compile or drops or alters a validated statement
     *   or the locale setting.
     */
    async run(testCase: TestCase): Promise<string> {
        const steps = testCase.modules.flatMap((module) => module.execution_steps);
        const statements = steps.flatMap((step) => step.statements.map((s) => s.code));
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
        const stepBlocks = steps
            .map((step) =>
                step.statements.length > 0
                    ? [
                          `STEP: ${step.step}`,
                          ...step.statements.map((s) => s.code),
                      ].join('\n')
                    : `STEP: ${step.step}\n(no statements)`,
            )
            .join('\n\n');
        const response = await this.llm.complete({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: renderPrompt('generator', {
                test_case_name: testCase.name,
                locale_setting: setting,
                steps: stepBlocks,
            }),
        });
        const script = `${stripFence(response).trim()}\n`;

        const syntaxErrors = syntaxDiagnostics(script);
        if (syntaxErrors.length > 0) {
            throw new GeneratorError(
                `Generated script does not compile: ${syntaxErrors.join('; ')}`,
            );
        }

        const missing = missingLines(script, [setting, ...statements]);
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

/** Remove a surrounding Markdown code fence, if the LLM added one. */
function stripFence(text: string): string {
    const lines = text.trim().split('\n');
    if (
        lines.length > 1 &&
        lines[0]?.startsWith('```') &&
        lines.at(-1)?.trim() === '```'
    ) {
        return lines.slice(1, -1).join('\n');
    }
    return text;
}

/** The syntax errors in `script`, as `line:column message` strings. */
function syntaxDiagnostics(script: string): string[] {
    const { diagnostics = [] } = ts.transpileModule(script, {
        fileName: 'generated.spec.ts',
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
    });
    return diagnostics.map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
        if (diagnostic.file === undefined || diagnostic.start === undefined) {
            return message;
        }
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
            diagnostic.start,
        );
        return `${line + 1}:${character + 1} ${message}`;
    });
}

/** Return the `required` lines not found, in order, in `script`. */
function missingLines(script: string, required: string[]): string[] {
    const lines = script.split('\n').map((line) => line.trim());
    const missing: string[] = [];
    let position = 0;
    for (const wanted of required.map((line) => line.trim()).filter(Boolean)) {
        const found = lines.indexOf(wanted, position);
        if (found === -1) {
            missing.push(wanted);
        } else {
            position = found + 1;
        }
    }
    return missing;
}
