"""CLI entrypoint wiring."""

import logging
from pathlib import Path
from typing import Annotated, NoReturn

import typer
from pydantic import ValidationError

from src.config import Settings, configure_logging
from src.exceptions import ValidatorError
from src.extractor.crawler import Crawler
from src.extractor.service import Extractor
from src.llm.factory import get_llm_provider
from src.model.test_case import Module, TestCase
from src.structurer.service import Structurer
from src.validator.service import Validator

logger = logging.getLogger(__name__)

app = typer.Typer(pretty_exceptions_enable=False, rich_markup_mode=None)

_MarkdownPath = Annotated[
    Path, typer.Argument(exists=True, dir_okay=False, readable=True)
]


@app.command()
def run(markdown_path: _MarkdownPath) -> None:
    """Run the pipeline on a markdown test case and print its current output.

    Single entry point -- levels aren't run separately. Currently runs
    Structurer -> Extractor/Validator (Level 1 -> 2) and prints Level 2
    JSON; Level 3 (Generator) will extend this without changing the
    invocation.
    """
    settings = _load_settings_or_fail()
    logger.info(
        "Running pipeline on %s (provider=%s)", markdown_path, settings.llm_provider
    )

    try:
        llm = get_llm_provider(settings)
        structurer = Structurer(llm)
        test_case = structurer.run(markdown_path.read_text(encoding="utf-8"))

        crawler = Crawler()
        extractor = Extractor(llm, settings, crawler)
        validator = Validator(llm)
        modules = [
            _extract_module(module, extractor, validator)
            for module in test_case.modules
        ]
    except Exception as exc:
        _log_fail(str(exc), exc, traceback=True)

    result = TestCase(name=test_case.name, modules=modules)
    typer.echo(result.model_dump_json(indent=2))


def _extract_module(
    module: Module, extractor: Extractor, validator: Validator
) -> Module:
    """Crawl, extract, and validate one module, retrying extraction once.

    Returns the module with validated extracted_data filled in.

    Raises:
        CrawlerError: If the module's page cannot be crawled.
        ValidatorError: If validation still fails after one retry.
    """
    extracted_module, html_by_step = extractor.run(module)
    validation = validator.run(extracted_module, html_by_step)
    if validation.is_valid:
        return extracted_module

    logger.warning(
        "Validation failed for %s, retrying extraction with feedback", module.url
    )
    extracted_module, html_by_step = extractor.run(module, feedback=validation.feedback)
    validation = validator.run(extracted_module, html_by_step)
    if not validation.is_valid:
        raise ValidatorError(
            f"Validation failed for {module.url} after retry:\n{validation.feedback}"
        )
    return extracted_module


def _load_settings_or_fail() -> Settings:
    """Load Settings from the environment, exiting with a clear error if invalid."""
    try:
        settings = Settings()
    except ValidationError as exc:
        configure_logging()
        _log_fail(f"Invalid configuration: {exc}", exc, traceback=False)

    configure_logging(settings)
    return settings


def _log_fail(message: str, exc: Exception, traceback: bool = False) -> NoReturn:
    """Log `exc` as a single clear error and exit with a non-zero status."""
    if traceback:
        logger.error(message, exc_info=exc)
    else:
        logger.error(message)
    raise typer.Exit(1) from exc


def main() -> None:
    """Run the application."""
    app()


if __name__ == "__main__":
    main()
