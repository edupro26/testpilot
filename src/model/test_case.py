"""The test case JSON contract, shared across Level 1 and Level 2.

Level 1 and Level 2 aren't separate schemas -- they differ only in whether
`statements` has been filled in yet (empty from the Structurer, populated
by the Extractor and proven by the Validator).
"""

from pydantic import BaseModel, Field


class StepStatement(BaseModel):
    """One validated Playwright statement belonging to an execution step.

    `code` is always a line Playwright MCP emitted, never one the LLM wrote.
    """

    code: str
    # why this line was accepted; informational only.
    reason: str = ""


class ExecutionStep(BaseModel):
    """A single step within a module."""

    step: str
    statements: list[StepStatement] = Field(default_factory=list)


class Module(BaseModel):
    """A page the test case interacts with, and the steps performed on it."""

    url: str
    description: str
    execution_steps: list[ExecutionStep]


class TestCase(BaseModel):
    """The full structured test case."""

    name: str
    modules: list[Module]
