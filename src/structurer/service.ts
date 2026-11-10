/** Structurer service: markdown test case -> structured TestCase. */

import { z } from 'zod';

import type { LLMProvider } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import { type TestCase, TestCaseSchema } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import { errorMessage, StructurerError } from '../runtime/exceptions.ts';

const SYSTEM_PROMPT = 'You are an expert QA automation engineer.';

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
        const response = await this.llm.complete({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: prompt,
            jsonMode: true,
        });
        logger.debug(`Raw LLM response (${response.length} chars): ${response}`);

        let data: unknown;
        try {
            data = JSON.parse(response);
        } catch (error) {
            throw new StructurerError(
                `LLM response was not valid JSON: ${errorMessage(error)}`,
                { code: 'LLM_RESPONSE_INVALID', cause: error },
            );
        }

        const parsed = TestCaseSchema.safeParse(data);
        if (!parsed.success) {
            throw new StructurerError(
                `LLM response did not match the TestCase shape: ${z.prettifyError(parsed.error)}`,
                { code: 'LLM_RESPONSE_INVALID' },
            );
        }
        const testCase = parsed.data;

        logger.info(
            `Structured ${JSON.stringify(testCase.name)} into ${testCase.modules.length} module(s)`,
        );
        return testCase;
    }
}
