"""The test case JSON contract, shared across Level 1 and Level 2.

Level 1 and Level 2 aren't separate schemas -- they differ only in whether
`extracted_data` has been filled in yet (empty from the Structurer,
populated by the Extractor/Validator).
"""

from pydantic import BaseModel, Field

from src.model.enums import ElementType, IdentifierType


class ExtractedData(BaseModel):
    """A single UI element identifier extracted for one execution step."""

    type: ElementType
    request_description: str
    identifier_type: IdentifierType
    identifier_tracking: str
    input_value: str | None = None


class ExecutionStep(BaseModel):
    """A single step within a module."""

    step: str
    extracted_data: list[ExtractedData] = Field(default_factory=list)


class Module(BaseModel):
    """A page the test case interacts with, and the steps performed on it."""

    url: str
    description: str
    execution_steps: list[ExecutionStep]


class TestCase(BaseModel):
    """The full structured test case."""

    name: str
    modules: list[Module]
