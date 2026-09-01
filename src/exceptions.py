"""Shared pipeline exceptions."""


class PipelineError(Exception):
    """Base exception for all pipeline stage failures."""


class StructurerError(PipelineError):
    """Raised when the Structurer cannot produce a valid TestCase."""
