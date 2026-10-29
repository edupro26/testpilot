"""The per-step agent loop: drive MCP, then collect what it actually ran.

The LLM never authors code; it only selects which emitted lines belong to the
step. That selection is enforced here, since the Validator `exec`s the result.
"""

import logging

from pydantic import BaseModel, Field, ValidationError

from src.exceptions import ExtractorError
from src.extractor.mcp.constants import COLLECTABLE_TOOLS
from src.extractor.mcp.server import McpTool, PlaywrightMCP
from src.extractor.utils import require_python
from src.llm.protocol import LLMProvider, ToolResult
from src.model.test_case import StepStatement
from src.prompt_loader import render_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."
_STEP_DONE = "step_done"

# Caps each tool result sent back to the model (a full snapshot is ~10k tokens).
_MAX_RESULT_CHARS = 8000

_STEP_DONE_TOOL = McpTool(
    name=_STEP_DONE,
    description=(
        "Report that the step is complete, listing the Playwright statements "
        "that belong to it. Every statement MUST be copied verbatim from a "
        "'Ran Playwright code' block of a successful tool call in this "
        "conversation. Do not write, edit, reformat or invent code."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "statements": {
                "type": "array",
                "description": (
                    "The step's statements, in execution order, excluding "
                    "exploratory detours such as failed attempts, snapshots "
                    "and searches."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": (
                                "One emitted line, copied exactly as it "
                                "appeared in a 'Ran Playwright code' block."
                            ),
                        },
                    },
                    "required": ["code"],
                },
            }
        },
        "required": ["statements"],
    },
)


class _CollectedStatement(BaseModel):
    """One statement the model claims belongs to the step."""

    code: str


class _StepDone(BaseModel):
    """The `step_done` payload."""

    statements: list[_CollectedStatement] = Field(default_factory=list)


class StepAgent:
    """Drives one execution step to completion against a live browser."""

    def __init__(
        self, llm: LLMProvider, mcp: PlaywrightMCP, *, max_turns: int = 25
    ) -> None:
        """Initialize with the collaborators the loop needs.

        Args:
            llm: Provides the tool-calling conversation.
            mcp: The live Playwright MCP connection.
            max_turns: Cap on assistant turns before the step is abandoned.
        """
        self._llm = llm
        self._mcp = mcp
        self._max_turns = max_turns
        self._tools = [
            tool.model_dump() for tool in [*mcp.list_tools(), _STEP_DONE_TOOL]
        ]

    def run(
        self,
        step: str,
        *,
        context: str,
        feedback: str | None = None,
    ) -> list[StepStatement]:
        """Perform `step` in the live browser and return its statements.

        Args:
            step: The execution step's text, from the structured test case.
            context: What the browser is already showing, and what earlier
                steps have established.
            feedback: Why the previous attempt at this step was rejected.

        Returns:
            The validated-by-construction statements for this step, in
            execution order. Empty if the step needed no browser action.

        Raises:
            ExtractorError: If the model never reports completion within
                `max_turns`, or reports a statement MCP never ran.
        """
        logger.info("Step: %s", step)
        emitted: list[str] = []

        conversation = self._llm.start_conversation(
            system_prompt=_SYSTEM_PROMPT,
            user_prompt=render_prompt(
                "extractor",
                step=step,
                context=context,
                feedback_section=(
                    ""
                    if not feedback
                    else (
                        "\nTHE PREVIOUS ATTEMPT AT THIS STEP WAS REJECTED:\n"
                        f"{feedback}\n"
                    )
                ),
            ),
            tools=self._tools,
        )

        results: list[ToolResult] | None = None
        for turn in range(self._max_turns):
            response = conversation.send(results)
            if not response.tool_calls:
                raise ExtractorError(
                    f"Model stopped without calling {_STEP_DONE} for step "
                    f"{step!r}: {response.text or '(no text)'}"
                )

            results = []
            for call in response.tool_calls:
                if call.name == _STEP_DONE:
                    logger.info("Step complete after %d turn(s)", turn + 1)
                    return self._collect(call.arguments, emitted, step)

                result = self._mcp.call_tool(call.name, call.arguments)
                # Only tools that honour `codegen: python` contribute code.
                if call.name in COLLECTABLE_TOOLS and result.code:
                    emitted.extend(result.code)
                    logger.debug("Emitted: %s", "; ".join(result.code))
                results.append(
                    ToolResult(
                        id=call.id,
                        content=result.content[:_MAX_RESULT_CHARS],
                        is_error=result.is_error,
                    )
                )

        raise ExtractorError(
            f"Step {step!r} did not complete within {self._max_turns} turns"
        )

    @staticmethod
    def _collect(arguments: dict, emitted: list[str], step: str) -> list[StepStatement]:
        """Validate the model's selection against what MCP actually ran.

        Args:
            arguments: The raw `step_done` payload.
            emitted: Every statement MCP reported running this step.
            step: The step's text, for error messages.

        Returns:
            The accepted statements.

        Raises:
            ExtractorError: If the payload is malformed, or names a
                statement MCP never ran.
        """
        try:
            done = _StepDone.model_validate(arguments)
        except ValidationError as exc:
            raise ExtractorError(
                f"{_STEP_DONE} payload for step {step!r} was malformed: {exc}"
            ) from exc

        allowed = {line.strip() for line in emitted}
        statements = []
        for claimed in done.statements:
            code = claimed.code.strip()
            if code not in allowed:
                raise ExtractorError(
                    f"Step {step!r} reported a statement that no collectable "
                    f"Playwright MCP tool emitted, so it was never run or cannot "
                    f"be written into the script:\n"
                    f"  claimed:  {code}\n"
                    f"  emitted:  {', '.join(sorted(allowed)) or '(nothing)'}"
                )
            require_python(code, step)
            statements.append(StepStatement(code=code))

        logger.info("Collected %d statement(s)", len(statements))
        return statements
