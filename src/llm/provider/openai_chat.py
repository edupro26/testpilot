"""Tool-calling conversation over the Chat Completions API, used by Azure OpenAI."""

import json
import logging

from openai import AzureOpenAI, OpenAI

from src.llm.protocol import ToolCall, ToolResult, ToolUseResponse

logger = logging.getLogger(__name__)


def to_openai_tools(tools: list[dict]) -> list[dict]:
    """Translate neutral MCP tool definitions to the Chat Completions shape.

    Args:
        tools: Tool definitions as `{"name", "description", "input_schema"}`.

    Returns:
        The same tools as `{"type": "function", "function": {...}}` entries.
    """
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                # Defensive cap; MCP's current descriptions stay well under it.
                "description": (tool.get("description") or "")[:1024],
                "parameters": tool.get("input_schema") or {},
            },
        }
        for tool in tools
    ]


class OpenAIChatConversation:
    """A stateful tool-calling exchange over Chat Completions.

    Sends no `temperature`: reasoning deployments reject any explicit value.
    """

    def __init__(
        self,
        client: OpenAI | AzureOpenAI,
        model: str,
        *,
        system_prompt: str,
        user_prompt: str,
        tools: list[dict],
    ) -> None:
        """Initialize the conversation with its opening turns.

        Args:
            client: An `OpenAI` or `AzureOpenAI` client.
            model: The model name.
            system_prompt: Instructions framing the model's role/behavior.
            user_prompt: The opening user turn.
            tools: Tool definitions in the neutral MCP shape.
        """
        self._client = client
        self._model = model
        self._tools = to_openai_tools(tools)
        self._messages: list[dict] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

    def send(self, results: list[ToolResult] | None = None) -> ToolUseResponse:
        """Append `results`, request the next turn, and record it."""
        for result in results or []:
            self._messages.append(
                {
                    "role": "tool",
                    "tool_call_id": result.id,
                    "content": result.content,
                }
            )

        response = self._client.chat.completions.create(
            model=self._model, messages=self._messages, tools=self._tools
        )
        message = response.choices[0].message
        self._messages.append(message.model_dump(exclude_none=True))

        return ToolUseResponse(
            text=message.content,
            tool_calls=[
                ToolCall(
                    id=call.id,
                    name=call.function.name,
                    arguments=_parse_arguments(call.function.arguments),
                )
                for call in (message.tool_calls or [])
            ],
        )


def _parse_arguments(raw: str | None) -> dict:
    """Parse a tool call's JSON arguments, tolerating an empty or bad payload."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Tool call arguments were not valid JSON: %s", raw[:200])
        return {}
