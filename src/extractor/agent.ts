/**
 * The per-step agent loop: drive MCP, then collect what it actually ran.
 *
 * The LLM never authors code; it only selects which emitted lines belong to the
 * step. That selection is enforced here, since the Validator runs the result.
 * Each report is checked against what the step asks, and a rejection goes back
 * to the agent while its browser is still live, to fix in the same conversation.
 */

import { z } from 'zod';

import type { LLMProvider, ToolDefinition, ToolResult } from '../llm/protocol.ts';
import { logger } from '../logger.ts';
import { statement, type StepStatement } from '../model/test-case.ts';
import { renderPrompt } from '../prompt-loader.ts';
import { ExtractorError } from '../runtime/exceptions.ts';
import { COLLECTABLE_TOOLS } from './mcp/constants.ts';
import type { McpConnection } from './mcp/server.ts';
import { requireStatement } from './utils.ts';

const SYSTEM_PROMPT = 'You are an expert QA automation engineer.';
const STEP_DONE = 'step_done';

// Caps each tool result sent back to the model (a full snapshot is ~10k tokens).
const MAX_RESULT_CHARS = 8000;

// Rejected reports the agent may fix in the same conversation before the step
// is handed back as rejected.
const MAX_REPAIRS = 2;

// Waits in the agent's own browser. The script's timing is measured by the
// Validator, so a wait the agent reports anyway is left out, not an error.
const WAIT_TOOL = 'browser_wait_for';

const ONLY_WAITS =
    `Only ${WAIT_TOOL} lines were reported, and they are not part of the script, ` +
    'so the step would do nothing. To verify that something appears, use a ' +
    'browser_verify_* tool and report the assertion it emits.';

const STEP_DONE_TOOL: ToolDefinition = {
    name: STEP_DONE,
    description:
        'Report that the step is complete, listing the Playwright statements ' +
        'that belong to it. Every statement MUST be copied verbatim from a ' +
        "'Ran Playwright code' block of a successful tool call in this " +
        'conversation. Do not write, edit, reformat or invent code. The ' +
        'statements are then checked against what the step asks; if they are ' +
        'rejected, the result says why, and you fix the step and call this again.',
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
    statements: z.array(z.object({ code: z.string() })),
});

/** Judges a step's reported statements against what the step asks. */
export type StepCheck = (statements: StepStatement[]) => Promise<StepResult>;

/** Options for one `StepAgent.run`. */
export interface StepRunOptions {
    /** What the browser is already showing, and what earlier steps established. */
    context: string;
    /** Why the previous attempt at this step was rejected. */
    feedback?: string;
    /** Checks each report; without it, the statements are returned unchecked. */
    check?: StepCheck;
}

/** What one `StepAgent.run` produced. */
export interface StepResult {
    /** The step's statements, in execution order. */
    statements: StepStatement[];
    /** Why the step is still rejected once the agent ran out of repairs. */
    rejection?: string;
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
     * A rejected `step_done` report goes back to the model as the call's
     * result, to fix in its still-live browser, up to `MAX_REPAIRS` times.
     *
     * @param step - The execution step's text.
     * @param options - The browser context, any retry feedback and the check.
     * @returns The step's statements, with the last rejection if the repairs
     *   ran out.
     * @throws {ExtractorError} If the model stops without reporting completion,
     *   or does not report it within `maxTurns`.
     */
    async run(
        step: string,
        { context, feedback, check }: StepRunOptions,
    ): Promise<StepResult> {
        logger.info(`Step: ${step}`);
        const emitted: string[] = [];
        const waits = new Set<string>();
        let repairs = 0;

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
                    { code: 'STEP_ABANDONED' },
                );
            }

            results = [];
            for (const call of response.toolCalls) {
                if (call.name === STEP_DONE) {
                    const collected = collect(call.arguments, emitted, waits, step);
                    const checked = await review(collected, check);
                    if (checked.rejection === undefined) {
                        logger.info(`Step complete after ${turn + 1} turn(s)`);
                        return checked;
                    }
                    if (repairs === MAX_REPAIRS) {
                        logger.warning(
                            `Step still rejected after ${repairs} repair(s)`,
                        );
                        return checked;
                    }
                    repairs++;
                    logger.info(
                        `Step rejected, the agent repairs it (${repairs}/${MAX_REPAIRS})`,
                    );
                    results.push({
                        id: call.id,
                        content: repairRequest(checked.rejection),
                        isError: true,
                    });
                    continue;
                }

                if (!this.tools.some((tool) => tool.name === call.name)) {
                    logger.warning(`The agent called an unknown tool: ${call.name}`);
                    results.push({
                        id: call.id,
                        content:
                            `There is no tool named ${JSON.stringify(call.name)}. ` +
                            'Call only the tools you were given, one at a time.',
                        isError: true,
                    });
                    continue;
                }

                const result = await this.mcp.callTool(call.name, call.arguments);
                // Only tools whose code stands on its own as a test line contribute.
                const code = result.code;
                if (call.name === WAIT_TOOL) {
                    for (const line of code) {
                        waits.add(line.trim());
                    }
                }
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
            { code: 'STEP_OUT_OF_TURNS' },
        );
    }
}

/**
 * Check a collected report. One that is invalid is rejected with none of its
 * statements, so none of them can be kept. One left empty by dropping its waits
 * is rejected: a verification step would otherwise pass as needing no
 * interaction.
 */
async function review(
    { statements, droppedWaits, invalid }: ReturnType<typeof collect>,
    check?: StepCheck,
): Promise<StepResult> {
    if (invalid !== undefined) {
        return { statements: [], rejection: invalid };
    }
    if (statements.length === 0 && droppedWaits > 0) {
        return { statements, rejection: ONLY_WAITS };
    }
    return (await check?.(statements)) ?? { statements };
}

/** Return a rejection to the model, as the result of its `step_done` call. */
function repairRequest(rejection: string): string {
    return (
        `${STEP_DONE} rejected:\n${rejection}\n` +
        `Your browser is still where you left it. Fix the step, then call ` +
        `${STEP_DONE} again with the step's complete list of statements.`
    );
}

/**
 * Validate the model's selection against what MCP actually ran.
 *
 * @param args - The raw `step_done` payload.
 * @param emitted - Every statement a collectable tool reported running.
 * @param waits - Every wait `browser_wait_for` ran; one reported is left out.
 * @param step - The step's text, for error messages.
 * @returns The accepted statements, and how many reported waits were left out;
 *   for a malformed payload or a statement MCP never ran, why the report is
 *   invalid, for the model to fix.
 * @throws {ExtractorError} If a collected statement does not parse on its own.
 */
function collect(
    args: Record<string, unknown>,
    emitted: string[],
    waits: Set<string>,
    step: string,
): { statements: StepStatement[]; droppedWaits: number; invalid?: string } {
    // Arguments that were not valid JSON, e.g. cut short, arrive as `{}`.
    const parsed = StepDoneSchema.safeParse(args);
    if (!parsed.success) {
        logger.warning(`${STEP_DONE} payload was malformed`);
        return {
            statements: [],
            droppedWaits: 0,
            invalid:
                `the ${STEP_DONE} arguments were malformed or cut short:\n` +
                z.prettifyError(parsed.error),
        };
    }

    const allowed = new Set(emitted.map((line) => line.trim()));
    const statements: StepStatement[] = [];
    let droppedWaits = 0;
    for (const claimed of parsed.data.statements) {
        const code = claimed.code.trim();
        if (waits.has(code) && !allowed.has(code)) {
            logger.warning(`Left a reported wait out of the step: ${code}`);
            droppedWaits++;
            continue;
        }
        if (!allowed.has(code)) {
            logger.warning(`Reported a statement no collectable tool emitted: ${code}`);
            return {
                statements: [],
                droppedWaits: 0,
                invalid:
                    'it reported a statement that no collectable Playwright MCP ' +
                    'tool emitted, so it was never run or cannot be written into ' +
                    'the script. Copy statements verbatim from a successful ' +
                    "tool call's 'Ran Playwright code' block.\n" +
                    `  claimed:  ${code}\n` +
                    `  emitted:  ${[...allowed].sort().join(', ') || '(nothing)'}`,
            };
        }
        requireStatement(code, step);
        statements.push(statement(code));
    }

    logger.info(`Collected ${statements.length} statement(s)`);
    return { statements, droppedWaits };
}
