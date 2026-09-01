"""Shared application exceptions."""


class PipelineError(Exception):
    """Base exception for all pipeline stage failures."""


class StructurerError(PipelineError):
    """Raised when the Structurer cannot produce a valid TestCase."""


class ConfigurationError(ValueError):
    """Raised when required application configuration is missing or invalid."""
