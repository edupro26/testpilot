/** Structurer service: markdown test case -> structured TestCase. */

import { completeJson, type LLMProvider } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import { type TestCase, TestCaseSchema } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import { StructurerError } from '../runtime/exceptions.ts';

/** Converts a markdown test case specification into a TestCase. */
export class Structurer {
    private readonly llm: LLMProvider;

    /**
     * Initialize with the LLM provider to use.
     *
     * @param llm - The LLM provider used to perform the conversion.
     */
    constructor(llm: LLMProvider) {
        this.llm = llm;
    }

    /**
     * Convert a markdown test case specification into a TestCase.
     *
     * @param markdown - The raw test case specification.
     * @returns The parsed and validated TestCase.
     * @throws {StructurerError} If the LLM response is not valid JSON or does not
     *   match the expected TestCase shape.
     */
    async run(markdown: string): Promise<TestCase> {
        logger.info(`Structuring test case (${markdown.length} chars of markdown)`);

        const prompt = renderPrompt('structurer', { test_case_markdown: markdown });
        const testCase = await completeJson(this.llm, prompt, {
            schema: TestCaseSchema,
            shape: 'the TestCase shape',
            error: StructurerError,
        });

        logger.info(
            `Structured ${JSON.stringify(testCase.name)} into ` +
                `${testCase.modules.length} module(s)`,
        );
        return testCase;
    }
}
