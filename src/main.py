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
from src.generator.service import Generator
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
    """Run the full pipeline on a markdown test case and persist its output.

    This is the pipeline's single entry point -- levels are not meant to
    be run separately. It runs Structurer -> Extractor/Validator (Level 1
    -> Level 2) -> Generator (Level 3), then writes the validated Level 2
    JSON and the generated Playwright script under
    `output/<markdown_path's parent folder name>/`, both named after the
    input markdown file. Framework selection (a `--framework` flag) is
    still pending (M4).
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
        result = TestCase(name=test_case.name, modules=modules)
        logger.info("Successfully extracted and validated %d modules", len(modules))
        logger.debug("Extracted JSON: %s", result.model_dump_json())

        generator = Generator(llm)
        script = generator.run(result)

        output_dir = Path("output") / markdown_path.parent.name
        output_dir.mkdir(parents=True, exist_ok=True)
        script_path = output_dir / f"{markdown_path.stem}.py"
        json_path = output_dir / f"{markdown_path.stem}.json"
        script_path.write_text(script, encoding="utf-8")
        json_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        logger.info("Wrote generated script to %s", script_path)
    except Exception as exc:
        _log_fail(str(exc), exc, traceback=True)


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
