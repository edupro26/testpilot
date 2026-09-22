"""Shared data shapes for extraction: raw LLM records and crawl results."""

from collections.abc import Callable
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from src.exceptions import ExtractorError
from src.model.enums import ElementType, IdentifierType
from src.model.test_case import ExtractedData


class ExtractedRecord(BaseModel):
    """One extracted element, tagged with which step it belongs to."""

    step_index: int
    type: ElementType
    request_description: str
    identifier_type: IdentifierType
    identifier_tracking: str
    input_value: str | None = None


@dataclass(frozen=True)
class CrawlExtraction:
    """The result of one crawl-and-extract call."""

    records: list[dict]
    html: str
    js_ok: bool


# A crawl-and-extract callable: (url, instruction, keywords, js_code) -> result.
RunCrawl = Callable[[str, str, frozenset[str], list[str] | None], CrawlExtraction]


def parse_records(raw_records: list[dict]) -> list[ExtractedRecord]:
    """Validate `raw_records` into `ExtractedRecord`s, or raise ExtractorError."""
    try:
        return [ExtractedRecord.model_validate(item) for item in raw_records]
    except ValidationError as exc:
        raise ExtractorError(
            f"LLM extraction result did not match the expected shape: {exc}"
        ) from exc


def to_extracted_data(record: ExtractedRecord) -> ExtractedData:
    """Convert a validated `ExtractedRecord` into its public `ExtractedData`."""
    return ExtractedData(
        type=record.type,
        request_description=record.request_description,
        identifier_type=record.identifier_type,
        identifier_tracking=record.identifier_tracking,
        input_value=record.input_value,
    )
