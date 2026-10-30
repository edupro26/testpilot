/**
 * The per-step agent loop: drive MCP, then collect what it actually ran.
 *
 * The LLM never authors code; it only selects which emitted lines belong to the
 * step. That selection is enforced here, since the Validator runs the result.
 */

import { z } from 'zod';

import { ExtractorError } from '../exceptions.ts';
import type { LLMProvider, ToolDefinition, ToolResult } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import type { StepStatement } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import { COLLECTABLE_TOOLS } from './mcp/constants.ts';
import type { McpConnection } from './mcp/server.ts';
import { requireStatement } from './utils.ts';

const SYSTEM_PROMPT = 'You are an expert QA automation engineer.';
const STEP_DONE = 'step_done';

// Caps each tool result sent back to the model (a full snapshot is ~10k tokens).
const MAX_RESULT_CHARS = 8000;

const STEP_DONE_TOOL: ToolDefinition = {
    name: STEP_DONE,
    description:
        'Report that the step is complete, listing the Playwright statements ' +
        'that belong to it. Every statement MUST be copied verbatim from a ' +
        "'Ran Playwright code' block of a successful tool call in this " +
        'conversation. Do not write, edit, reformat or invent code.',
    inputSchema: {
        type: 'object',
        properties: {
            statements: {
                type: 'array',
                description:
                    "The step's statements, in execution order, excluding " +
                    'exploratory detours such as failed attempts, snapshots ' +
                    'and searches.',
                items: {
                    type: 'object',
                    properties: {
                        code: {
                            type: 'string',
                            description:
                                'One emitted line, copied exactly as it ' +
                                "appeared in a 'Ran Playwright code' block.",
                        },
                    },
                    required: ['code'],
                },
            },
        },
        required: ['statements'],
    },
};

/** The `step_done` payload. */
const StepDoneSchema = z.object({
    statements: z.array(z.object({ code: z.string() })).default([]),
});

/** Options for one `StepAgent.run`. */
export interface StepRunOptions {
    /** What the browser is already showing, and what earlier steps established. */
    context: string;
    /** Why the previous attempt at this step was rejected. */
    feedback?: string;
}

/** Drives one execution step to completion against a live browser. */
export class StepAgent {
    private readonly llm: LLMProvider;
    private readonly mcp: McpConnection;
    private readonly maxTurns: number;
    private readonly tools: ToolDefinition[];

    /**
     * Initialize with the collaborators the loop needs.
     *
     * @param llm - Provides the tool-calling conversation.
     * @param mcp - The live Playwright MCP connection.
     * @param maxTurns - Cap on assistant turns before the step is abandoned.
     */
    constructor(llm: LLMProvider, mcp: McpConnection, maxTurns = 25) {
        this.llm = llm;
        this.mcp = mcp;
        this.maxTurns = maxTurns;
        this.tools = [...mcp.listTools(), STEP_DONE_TOOL];
    }

    /**
     * Perform `step` in the live browser and return its statements.
     *
     * @param step - The execution step's text, from the structured test case.
     * @param options - The browser context and any retry feedback.
     * @returns The validated-by-construction statements for this step, in
     *   execution order. Empty if the step needed no browser action.
     * @throws {ExtractorError} If the model never reports completion within
     *   `maxTurns`, or reports a statement MCP never ran.
     */
    async run(
        step: string,
        { context, feedback }: StepRunOptions,
    ): Promise<StepStatement[]> {
        logger.info(`Step: ${step}`);
        const emitted: string[] = [];

        const conversation = this.llm.startConversation({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: renderPrompt('extractor', {
                step,
                context,
                feedback_section: feedback
                    ? `\nTHE PREVIOUS ATTEMPT AT THIS STEP WAS REJECTED:\n${feedback}\n`
                    : '',
            }),
            tools: this.tools,
        });

        let results: ToolResult[] | undefined;
        for (let turn = 0; turn < this.maxTurns; turn++) {
            const response = await conversation.send(results);
            if (response.toolCalls.length === 0) {
                const text = response.text ?? '';
                throw new ExtractorError(
                    `Model stopped without calling ${STEP_DONE} for step ` +
                        `${JSON.stringify(step)}: ${text === '' ? '(no text)' : text}`,
                );
            }

            results = [];
            for (const call of response.toolCalls) {
                if (call.name === STEP_DONE) {
                    logger.info(`Step complete after ${turn + 1} turn(s)`);
                    return collect(call.arguments, emitted, step);
                }

                const result = await this.mcp.callTool(call.name, call.arguments);
                // Only tools whose code stands on its own as a test line contribute.
                const code = result.code;
                if (COLLECTABLE_TOOLS.has(call.name) && code.length > 0) {
                    emitted.push(...code);
                    logger.debug(`Emitted: ${code.join('; ')}`);
                }
                results.push({
                    id: call.id,
                    content: result.content.slice(0, MAX_RESULT_CHARS),
                    isError: result.isError,
                });
            }
        }

        throw new ExtractorError(
            `Step ${JSON.stringify(step)} did not complete within ${this.maxTurns} turns`,
        );
    }
}

/**
 * Validate the model's selection against what MCP actually ran.
 *
 * @param args - The raw `step_done` payload.
 * @param emitted - Every statement MCP reported running this step.
 * @param step - The step's text, for error messages.
 * @returns The accepted statements.
 * @throws {ExtractorError} If the payload is malformed, or names a statement
 *   MCP never ran.
 */
function collect(
    args: Record<string, unknown>,
    emitted: string[],
    step: string,
): StepStatement[] {
    const parsed = StepDoneSchema.safeParse(args);
    if (!parsed.success) {
        throw new ExtractorError(
            `${STEP_DONE} payload for step ${JSON.stringify(step)} was malformed: ` +
                z.prettifyError(parsed.error),
        );
    }

    const allowed = new Set(emitted.map((line) => line.trim()));
    const statements: StepStatement[] = [];
    for (const claimed of parsed.data.statements) {
        const code = claimed.code.trim();
        if (!allowed.has(code)) {
            throw new ExtractorError(
                `Step ${JSON.stringify(step)} reported a statement that no collectable ` +
                    `Playwright MCP tool emitted, so it was never run or cannot ` +
                    `be written into the script:\n` +
                    `  claimed:  ${code}\n` +
                    `  emitted:  ${[...allowed].sort().join(', ') || '(nothing)'}`,
            );
        }
        requireStatement(code, step);
        statements.push({ code, reason: '' });
    }

    logger.info(`Collected ${statements.length} statement(s)`);
    return statements;
}
