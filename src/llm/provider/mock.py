"""Deterministic, offline stand-in for a real LLM provider."""

from collections.abc import Callable

from src.llm.protocol import ToolCall, ToolResult, ToolUseResponse


class MockProvider:
    """Returns fixed or computed responses, with no network calls."""

    def __init__(
        self,
        response: str | Callable[[str, str], str] = "",
        turns: list[ToolUseResponse] | None = None,
    ) -> None:
        """Initialize with a canned completion and/or a scripted conversation.

        Args:
            response: A fixed string always returned by `complete`, or a
                callable taking (system_prompt, user_prompt).
            turns: Assistant turns replayed in order by every conversation
                this provider starts.
        """
        self._response = response
        self._turns = turns or []
        self.conversations: list[MockConversation] = []

    def complete(
        self, *, system_prompt: str, user_prompt: str, json_mode: bool = False
    ) -> str:
        """Return the configured canned response."""
        _ = json_mode
        if callable(self._response):
            return self._response(system_prompt, user_prompt)
        return self._response

    def start_conversation(
        self, *, system_prompt: str, user_prompt: str, tools: list[dict]
    ) -> "MockConversation":
        """Return a conversation replaying this provider's scripted turns."""
        conversation = MockConversation(
            self._turns,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            tools=tools,
        )
        self.conversations.append(conversation)
        return conversation


class MockConversation:
    """Replays a fixed list of assistant turns, recording what it was sent."""

    def __init__(
        self,
        turns: list[ToolUseResponse],
        *,
        system_prompt: str = "",
        user_prompt: str = "",
        tools: list[dict] | None = None,
    ) -> None:
        """Initialize with the turns to replay and the opening context.

        Args:
            turns: Assistant turns returned in order, one per `send()`.
            system_prompt: Recorded for assertions.
            user_prompt: Recorded for assertions.
            tools: Recorded for assertions.
        """
        self._turns = list(turns)
        self.system_prompt = system_prompt
        self.user_prompt = user_prompt
        self.tools = tools or []
        self.sent: list[list[ToolResult]] = []

    def send(self, results: list[ToolResult] | None = None) -> ToolUseResponse:
        """Record `results` and return the next scripted turn.

        Returns:
            The next scripted turn, or an empty turn once they run out --
            which ends an agent loop rather than hanging it.
        """
        self.sent.append(list(results or []))
        if not self._turns:
            return ToolUseResponse(text="(no more scripted turns)")
        return self._turns.pop(0)


def tool_turn(name: str, arguments: dict, call_id: str = "call-1") -> ToolUseResponse:
    """Build a one-tool-call assistant turn, for scripting tests.

    Args:
        name: The tool to call.
        arguments: The call's arguments.
        call_id: The id results are matched back to.

    Returns:
        A `ToolUseResponse` carrying that single call.
    """
    return ToolUseResponse(
        tool_calls=[ToolCall(id=call_id, name=name, arguments=arguments)]
    )
