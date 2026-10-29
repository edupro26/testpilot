"""LLM provider interface: one-shot `complete()` and tool-calling conversations.

Conversation state stays inside each provider, as the wire formats differ too
much for a shared message model.
"""

from typing import Protocol

from pydantic import BaseModel, Field


class ToolCall(BaseModel):
    """A single tool invocation requested by the model."""

    id: str
    name: str
    arguments: dict = Field(default_factory=dict)


class ToolResult(BaseModel):
    """The outcome of one `ToolCall`, fed back to the model."""

    id: str
    content: str
    is_error: bool = False


class ToolUseResponse(BaseModel):
    """One assistant turn: free text, tool calls, or both."""

    text: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)


class Conversation(Protocol):
    """A stateful, multi-turn exchange with tools bound."""

    def send(self, results: list[ToolResult] | None = None) -> ToolUseResponse:
        """Advance the conversation by one assistant turn.

        Args:
            results: Outcomes of the tool calls from the previous turn.
                `None` on the opening turn.

        Returns:
            The assistant's next turn.
        """
        ...


class LLMProvider(Protocol):
    """Interface every LLM provider implementation must satisfy."""

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the raw text completion for the given prompt pair.

        Args:
            system_prompt: Instructions framing the model's role/behavior.
            user_prompt: The rendered, stage-specific prompt content.
            json_mode: Whether to request a JSON-only response, if the
                provider supports it.

        Returns:
            The completion text.
        """
        ...

    def start_conversation(
        self, *, system_prompt: str, user_prompt: str, tools: list[dict]
    ) -> Conversation:
        """Open a tool-calling conversation.

        Args:
            system_prompt: Instructions framing the model's role/behavior.
            user_prompt: The opening user turn.
            tools: Tool definitions in the provider-neutral MCP shape --
                `{"name", "description", "input_schema"}` -- which each
                provider translates to its own wire format.

        Returns:
            A conversation ready for its first `send()`.
        """
        ...
