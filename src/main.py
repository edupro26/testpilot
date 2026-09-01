"""CLI entrypoint wiring."""

import logging
from pathlib import Path
from typing import Annotated, NoReturn

import typer
from pydantic import ValidationError

from src.config import Settings, configure_logging
from src.llm.factory import get_llm_provider
from src.structurer.service import Structurer

logger = logging.getLogger(__name__)

app = typer.Typer(pretty_exceptions_enable=False, rich_markup_mode=None)


@app.command()
def structure(
    markdown_path: Annotated[
        Path, typer.Argument(exists=True, dir_okay=False, readable=True)
    ],
) -> None:
    """Run the Structurer on a markdown test-case file and print the Level 1 JSON."""
    try:
        settings = Settings()
    except ValidationError as exc:
        configure_logging()
        _log_fail(f"Invalid configuration: {exc}", exc, traceback=False)

    configure_logging(settings)
    logger.info(
        "Running Structurer on %s (provider=%s)", markdown_path, settings.llm_provider
    )

    try:
        structurer = Structurer(get_llm_provider(settings))
        test_case = structurer.run(markdown_path.read_text(encoding="utf-8"))
    except Exception as exc:
        _log_fail(str(exc), exc, traceback=True)

    typer.echo(test_case.model_dump_json(indent=2))


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
