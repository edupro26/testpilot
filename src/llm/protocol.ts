/**
 * LLM provider interface: one-shot `complete()` and tool-calling conversations,
 * and `completeJson()` on top of it for the stages that ask for JSON.
 *
 * Conversation state stays inside each provider, as the wire formats differ too
 * much for a shared message model.
 */

import { z } from 'zod';

import { logger } from '../logger.ts';
import { errorMessage, type PipelineError } from '../runtime/exceptions.ts';

/** The role every pipeline stage gives the model. */
export const SYSTEM_PROMPT = 'You are an expert QA automation engineer.';

/** A single tool invocation requested by the model. */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/** The outcome of one `ToolCall`, fed back to the model. */
export interface ToolResult {
    id: string;
    content: string;
    isError?: boolean;
}

/** One assistant turn: free text, tool calls, or both. */
export interface ToolUseResponse {
    text?: string | null;
    toolCalls: ToolCall[];
}

/** A tool definition in the provider-neutral MCP shape. */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/** The prompt pair for a one-shot completion. */
export interface CompletionRequest {
    /** Instructions framing the model's role/behavior. */
    systemPrompt: string;
    /** The rendered, stage-specific prompt content. */
    userPrompt: string;
    /** Whether to request a JSON-only response, if the provider supports it. */
    jsonMode?: boolean;
}

/** The opening of a tool-calling conversation. */
export interface ConversationRequest {
    /** Instructions framing the model's role/behavior. */
    systemPrompt: string;
    /** The opening user turn. */
    userPrompt: string;
    /**
     * Tool definitions in the provider-neutral MCP shape, which each provider
     * translates to its own wire format.
     */
    tools: ToolDefinition[];
}

/** A stateful, multi-turn exchange with tools bound. */
export interface Conversation {
    /**
     * Advance the conversation by one assistant turn.
     *
     * @param results - Outcomes of the tool calls from the previous turn.
     *   Omitted on the opening turn.
     * @returns The assistant's next turn.
     */
    send(results?: ToolResult[]): Promise<ToolUseResponse>;
}

/** Interface every LLM provider implementation must satisfy. */
export interface LLMProvider {
    /**
     * Return the raw text completion for the given prompt pair.
     *
     * @returns The completion text.
     */
    complete(request: CompletionRequest): Promise<string>;

    /**
     * Open a tool-calling conversation.
     *
     * @returns A conversation ready for its first `send()`.
     */
    startConversation(request: ConversationRequest): Conversation;
}

/** What a JSON reply must be, and the error a stage raises when it is not. */
export interface JsonReply<T> {
    /** The shape the reply must match. */
    schema: z.ZodType<T>;
    /** The shape's name in error messages, e.g. `the TestCase shape`. */
    shape: string;
    /** The stage's error. */
    error: new (...args: ConstructorParameters<typeof PipelineError>) => PipelineError;
}

/**
 * Ask for a JSON completion and check it against the expected shape.
 *
 * @param llm - The provider to ask.
 * @param userPrompt - The rendered, stage-specific prompt.
 * @param reply - The shape the reply must match, and the stage's error.
 * @returns The reply, parsed and validated.
 * @throws {PipelineError} `reply.error`, with code `LLM_RESPONSE_INVALID`, if
 *   the reply is not valid JSON or does not match the shape.
 */
export async function completeJson<T>(
    llm: LLMProvider,
    userPrompt: string,
    reply: JsonReply<T>,
): Promise<T> {
    const response = await llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
    });
    logger.debug(`Raw LLM response (${response.length} chars): ${response}`);

    let data: unknown;
    try {
        data = JSON.parse(response);
    } catch (error) {
        throw new reply.error(
            `LLM response was not valid JSON: ${errorMessage(error)}`,
            {
                code: 'LLM_RESPONSE_INVALID',
                cause: error,
            },
        );
    }
    const parsed = reply.schema.safeParse(data);
    if (!parsed.success) {
        throw new reply.error(
            `LLM response did not match ${reply.shape}: ` +
                z.prettifyError(parsed.error),
            { code: 'LLM_RESPONSE_INVALID' },
        );
    }
    return parsed.data;
}
