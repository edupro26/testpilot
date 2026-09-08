"""The test case JSON contract, shared across Level 1 and Level 2.

The Structurer produces this shape with every `extracted_data` list empty;
the Extractor and Validator (Level 2) populate it per execution step.
Level 1 and Level 2 are not separate schemas — they differ only in whether
`extracted_data` has been filled in yet.
"""

from pydantic import BaseModel, Field

from src.model.enums import ElementType, IdentifierType


class ExtractedData(BaseModel):
    """A single UI element identifier extracted for one execution step."""

    type: ElementType
    request_description: str
    identifier_type: IdentifierType
    identifier_tracking: str


class ExecutionStep(BaseModel):
    """A single step within a module.

    `extracted_data` is empty as produced by the Structurer; the Extractor
    fills it in during Level 2.
    """

    step: str
    extracted_data: list[ExtractedData] = Field(default_factory=list)


class Module(BaseModel):
    """A page the test case interacts with, and the steps performed on it.

    `url` is inferred by the LLM from prose alone at Level 1 and is not yet
    validated against a real page — that happens when the Crawler tries to
    fetch it in Level 2. It is kept as a plain string rather than a
    validated URL type so an imprecise guess here doesn't hard-fail the
    Structurer.
    """

    url: str
    description: str
    execution_steps: list[ExecutionStep]


class TestCase(BaseModel):
    """The full structured test case."""

    name: str
    modules: list[Module]
