/** Tool-calling conversation over the Chat Completions API, used by Azure OpenAI. */

import type { AzureOpenAI, OpenAI } from 'openai';
import type {
    ChatCompletionFunctionTool,
    ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

import { logger } from '../../logger.ts';
import type {
    Conversation,
    ConversationRequest,
    ToolDefinition,
    ToolResult,
    ToolUseResponse,
} from '../protocol.ts';

/**
 * Translate neutral MCP tool definitions to the Chat Completions shape.
 *
 * @param tools - Tool definitions in the neutral MCP shape.
 * @returns The same tools as `{type: "function", function: {...}}` entries.
 */
export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionFunctionTool[] {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            // Defensive cap; MCP's current descriptions stay well under it.
            description: tool.description.slice(0, 1024),
            parameters: tool.inputSchema,
        },
    }));
}

/**
 * A stateful tool-calling exchange over Chat Completions.
 *
 * Sends no `temperature`: reasoning deployments reject any explicit value.
 */
export class OpenAIChatConversation implements Conversation {
    private readonly client: OpenAI | AzureOpenAI;
    private readonly model: string;
    private readonly tools: ChatCompletionFunctionTool[];
    private readonly messages: ChatCompletionMessageParam[];

    /**
     * Initialize the conversation with its opening turns.
     *
     * @param client - An `OpenAI` or `AzureOpenAI` client.
     * @param model - The model name.
     * @param request - The prompts and the tools to bind.
     */
    constructor(
        client: OpenAI | AzureOpenAI,
        model: string,
        request: ConversationRequest,
    ) {
        this.client = client;
        this.model = model;
        this.tools = toOpenAITools(request.tools);
        this.messages = [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
        ];
    }

    /** Append `results`, request the next turn, and record it. */
    async send(results: ToolResult[] = []): Promise<ToolUseResponse> {
        for (const result of results) {
            this.messages.push({
                role: 'tool',
                tool_call_id: result.id,
                content: result.content,
            });
        }

        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: this.messages,
            tools: this.tools,
        });
        const message = response.choices[0]?.message;
        if (message === undefined) {
            return { text: null, toolCalls: [] };
        }
        const calls = (message.tool_calls ?? []).filter(
            (call) => call.type === 'function',
        );
        this.messages.push({
            role: 'assistant',
            content: message.content,
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
        });

        return {
            text: message.content,
            toolCalls: calls.map((call) => ({
                id: call.id,
                name: call.function.name,
                arguments: parseArguments(call.function.arguments),
            })),
        };
    }
}

/** Parse a tool call's JSON arguments, tolerating an empty or bad payload. */
function parseArguments(raw: string | undefined): Record<string, unknown> {
    if (!raw) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        logger.warning(`Tool call arguments were not valid JSON: ${raw.slice(0, 200)}`);
        return {};
    }
}
