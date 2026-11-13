/** Deterministic, offline stand-in for a real LLM provider. */

import type {
    CompletionRequest,
    Conversation,
    ConversationRequest,
    LLMProvider,
    ToolDefinition,
    ToolResult,
    ToolUseResponse,
} from '../protocol.ts';

/** A canned completion: fixed, or computed from (systemPrompt, userPrompt). */
export type MockResponse =
    string | ((systemPrompt: string, userPrompt: string) => string);

/** Returns fixed or computed responses, with no network calls. */
export class MockProvider implements LLMProvider {
    readonly conversations: MockConversation[] = [];
    private readonly response: MockResponse;
    private readonly turns: ToolUseResponse[];

    /**
     * Initialize with a canned completion and/or a scripted conversation.
     *
     * @param response - A fixed string always returned by `complete`, or a
     *   function taking (systemPrompt, userPrompt).
     * @param turns - Assistant turns replayed in order by every conversation
     *   this provider starts.
     */
    constructor(response: MockResponse = '', turns: ToolUseResponse[] = []) {
        this.response = response;
        this.turns = turns;
    }

    /**
     * Return the configured canned response.
     *
     * @param request - The prompt pair, passed to a computed response.
     * @returns The fixed response, or what the function returns for the prompts.
     */
    complete({ systemPrompt, userPrompt }: CompletionRequest): Promise<string> {
        return Promise.resolve(
            typeof this.response === 'function'
                ? this.response(systemPrompt, userPrompt)
                : this.response,
        );
    }

    /**
     * Return a conversation replaying this provider's scripted turns.
     *
     * @param request - The opening prompts and tools, recorded on the conversation.
     * @returns The new conversation, also appended to `conversations`.
     */
    startConversation(request: ConversationRequest): MockConversation {
        const conversation = new MockConversation(this.turns, request);
        this.conversations.push(conversation);
        return conversation;
    }
}

/** Replays a fixed list of assistant turns, recording what it was sent. */
export class MockConversation implements Conversation {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly tools: ToolDefinition[];
    readonly sent: ToolResult[][] = [];
    private readonly turns: ToolUseResponse[];

    /**
     * Initialize with the turns to replay and the opening context.
     *
     * @param turns - Assistant turns returned in order, one per `send()`.
     * @param request - The opening prompts and tools, recorded for assertions.
     */
    constructor(turns: ToolUseResponse[], request: Partial<ConversationRequest> = {}) {
        this.turns = [...turns];
        this.systemPrompt = request.systemPrompt ?? '';
        this.userPrompt = request.userPrompt ?? '';
        this.tools = request.tools ?? [];
    }

    /**
     * Record `results` and return the next scripted turn.
     *
     * @param results - The tool results to record; none on the opening turn.
     * @returns The next scripted turn, or an empty turn once they run out --
     *   which ends an agent loop rather than hanging it.
     */
    send(results: ToolResult[] = []): Promise<ToolUseResponse> {
        this.sent.push([...results]);
        return Promise.resolve(
            this.turns.shift() ?? { text: '(no more scripted turns)', toolCalls: [] },
        );
    }
}

/**
 * Build a one-tool-call assistant turn, for scripting tests.
 *
 * @param name - The tool to call.
 * @param args - The call's arguments.
 * @param callId - The id results are matched back to.
 * @returns A `ToolUseResponse` carrying that single call.
 */
export function toolTurn(
    name: string,
    args: Record<string, unknown>,
    callId = 'call-1',
): ToolUseResponse {
    return { toolCalls: [{ id: callId, name, arguments: args }] };
}
