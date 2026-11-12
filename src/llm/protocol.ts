/**
 * LLM provider interface: one-shot `complete()` and tool-calling conversations.
 *
 * Conversation state stays inside each provider, as the wire formats differ too
 * much for a shared message model.
 */

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
