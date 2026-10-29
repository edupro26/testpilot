"""CLI entrypoint wiring."""

import logging
from pathlib import Path
from typing import Annotated, NoReturn

import typer
from pydantic import ValidationError

from src.config import Settings, configure_logging
from src.exceptions import ValidatorError
from src.extractor.mcp.server import PlaywrightMCP
from src.extractor.service import Extractor
from src.extractor.utils import to_execution_steps
from src.generator.service import Generator
from src.llm.factory import get_llm_provider
from src.llm.protocol import LLMProvider
from src.model.test_case import Module, StepStatement, TestCase
from src.structurer.service import Structurer
from src.validator.browser import ValidationBrowser
from src.validator.service import Validator

logger = logging.getLogger(__name__)

app = typer.Typer(pretty_exceptions_enable=False, rich_markup_mode=None)

_MarkdownPath = Annotated[
    Path, typer.Argument(exists=True, dir_okay=False, readable=True)
]


@app.command()
def run(markdown_path: _MarkdownPath) -> None:
    """Run the full pipeline on a markdown test case and persist its output.

    Writes the validated test case JSON and the generated script to
    `output/<parent folder>/<stem>.{json,py}`. Needs a Playwright MCP server
    at MCP_URL.
    """
    settings = _load_settings_or_fail()
    logger.info(
        "Running pipeline on %s (provider=%s)", markdown_path, settings.llm_provider
    )

    try:
        llm = get_llm_provider(settings)
        structurer = Structurer(llm)
        test_case = structurer.run(markdown_path.read_text(encoding="utf-8"))

        result = _extract_and_validate(test_case, llm, settings)
        logger.info("Extracted and validated %d module(s)", len(result.modules))

        output_dir = Path("output") / markdown_path.parent.name
        output_dir.mkdir(parents=True, exist_ok=True)
        json_path = output_dir / f"{markdown_path.stem}.json"
        json_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        logger.info("Wrote validated test case to %s", json_path)

        generator = Generator(llm, locale=settings.browser_locale)
        script = generator.run(result)

        script_path = output_dir / f"{markdown_path.stem}.py"
        script_path.write_text(script, encoding="utf-8")
        logger.info("Wrote generated script to %s", script_path)
    except Exception as exc:
        _log_fail(str(exc), exc, traceback=True)


def _extract_and_validate(
    test_case: TestCase, llm: LLMProvider, settings: Settings
) -> TestCase:
    """Extract and validate every module, sharing one MCP and one validation browser.

    Args:
        test_case: The structured test case.
        llm: The LLM provider.
        settings: Application settings, for MCP_URL and MCP_MAX_TURNS.

    Returns:
        The test case with every step's statements filled in and proven.

    Raises:
        ValidatorError: If a step still fails validation after one retry.
    """
    with (
        PlaywrightMCP(settings.mcp_url) as mcp,
        ValidationBrowser(locale=settings.browser_locale) as browser,
    ):
        extractor = Extractor(llm, mcp, max_turns=settings.mcp_max_turns)
        validator = Validator(llm, browser)
        history: list[str] = []
        modules = [
            _extract_module(module, extractor, validator, mcp, browser, history)
            for module in test_case.modules
        ]
    return TestCase(name=test_case.name, modules=modules)


def _extract_module(
    module: Module,
    extractor: Extractor,
    validator: Validator,
    mcp: PlaywrightMCP,
    browser: ValidationBrowser,
    history: list[str],
) -> Module:
    """Drive one module's steps, validating each before the next begins.

    Args:
        module: The module to process.
        extractor: Drives the live browser per step.
        validator: Replays and judges each step.
        mcp: The live MCP connection, reset before a retry.
        browser: The validation browser, whose URL a reset MCP returns to.
        history: Accepted statements so far, extended in place so later
            modules know what the browser is already showing.

    Returns:
        The module with every step's statements filled in.

    Raises:
        ValidatorError: If a step still fails validation after one retry.
    """
    statements_by_step: list[list[StepStatement]] = []
    for index in range(len(module.execution_steps)):
        statements = _extract_step(
            module, index, extractor, validator, mcp, browser, history
        )
        statements_by_step.append(statements)
        history.extend(statement.code for statement in statements)

    return Module(
        url=module.url,
        description=module.description,
        execution_steps=to_execution_steps(module, statements_by_step),
    )


def _extract_step(
    module: Module,
    index: int,
    extractor: Extractor,
    validator: Validator,
    mcp: PlaywrightMCP,
    browser: ValidationBrowser,
    history: list[str],
) -> list[StepStatement]:
    """Extract and validate one step, retrying once with feedback.

    Both browsers are reset before the retry. The MCP browser only gets the
    URL back, so the agent is told to redo the setup it needs, unreported.

    Raises:
        ValidatorError: If the step still fails after the retry.
    """
    step = module.execution_steps[index]
    statements = extractor.run_step(module, index, history=history)
    verdict = validator.run(step.step, statements)
    if verdict.is_valid:
        return verdict.statements

    logger.warning("Step %r rejected, retrying with feedback", step.step)
    url = _reset_browsers(mcp, browser, module, history)
    statements = extractor.run_step(
        module, index, history=history, feedback=verdict.feedback, reset_to=url
    )
    verdict = validator.run(step.step, statements)
    if not verdict.is_valid:
        raise ValidatorError(
            f"Step {step.step!r} failed validation after retry:\n{verdict.feedback}"
        )
    return verdict.statements


def _reset_browsers(
    mcp: PlaywrightMCP,
    browser: ValidationBrowser,
    module: Module,
    history: list[str],
) -> str:
    """Put both browsers back to a clean pre-step state before a retry.

    The validation browser re-runs the validated prefix; the MCP browser is
    reconnected and sent to the validation browser's URL.

    Returns:
        The URL the MCP browser was sent to.
    """
    browser.reset()
    if history:
        browser.run([StepStatement(code=code) for code in history])

    url = browser.page.url
    if url in ("", "about:blank"):
        url = module.url
    mcp.reset()
    mcp.call_tool("browser_navigate", {"url": url})
    logger.info("Both browsers reset to %s for the retry", url)
    return url


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
