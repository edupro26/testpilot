"""Shared application exceptions."""


class PipelineError(Exception):
    """Base exception for all pipeline stage failures."""


class StructurerError(PipelineError):
    """Raised when the Structurer cannot produce a valid TestCase."""


class CrawlerError(PipelineError):
    """Raised when the Crawler fails to execute a crawl."""


class ExtractorError(PipelineError):
    """Raised when the Extractor cannot produce a valid Module."""


class ValidatorError(PipelineError):
    """Raised when the Validator cannot produce a valid ValidationResult."""


class ConfigurationError(ValueError):
    """Raised when required application configuration is missing or invalid."""
