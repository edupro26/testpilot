"""Shared application exceptions."""


class PipelineError(Exception):
    """Base exception for all pipeline stage failures."""


class StructurerError(PipelineError):
    """Raised when the Structurer cannot produce a valid TestCase."""


class McpError(PipelineError):
    """Raised when the Playwright MCP server is unreachable or misbehaves."""


class ExtractorError(PipelineError):
    """Raised when the Extractor cannot produce a valid Module."""


class ValidatorError(PipelineError):
    """Raised when the Validator cannot produce a valid ValidationResult."""


class GeneratorError(PipelineError):
    """Raised when the Generator cannot produce a valid test script."""


class ConfigurationError(ValueError):
    """Raised when required application configuration is missing or invalid."""
