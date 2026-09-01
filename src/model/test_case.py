"""Level 1 JSON contract: the structured test case produced by Structurer."""

from pydantic import BaseModel, Field


class ExecutionStep(BaseModel):
    """A single step within a module."""

    step: str
    extracted_data: list[str] = Field(default_factory=list)


class Module(BaseModel):
    """A page the test case interacts with, and the steps performed on it.

    `url` is inferred by the LLM from prose alone at this stage and is not
    yet validated against a real page — that happens when the Crawler and
    Validator ground it in Level 2. It is kept as a plain string rather than
    a validated URL type so an imprecise guess here doesn't hard-fail the
    Structurer; correcting it is Level 2's job.
    """

    url: str
    description: str
    execution_steps: list[ExecutionStep]


class TestCase(BaseModel):
    """The full Level 1 structured test case."""

    name: str
    modules: list[Module]
