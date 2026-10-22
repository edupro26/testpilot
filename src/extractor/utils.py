"""Helpers for the Extractor: prompt context, collection checks, step rebuilding."""

from src.exceptions import ExtractorError
from src.model.test_case import ExecutionStep, Module, StepStatement


def describe_browser_context(
    module: Module, history: list[str], reset_to: str | None = None
) -> str:
    """Describe what the browser is already showing, for the agent's prompt.

    Args:
        module: The module the step belongs to.
        history: Statements already accepted for earlier steps.
        reset_to: The URL a freshly reset MCP browser was sent to, when
            retrying. Earlier steps' state is then gone from it.

    Returns:
        A short natural-language briefing.
    """
    done = "\n".join(f"  {code}" for code in history)

    if reset_to is not None:
        fresh = (
            f"The browser was just reset for this retry: it is a fresh session "
            f"(no cookies, no login, nothing stored) open at {reset_to}."
        )
        if not history:
            return f"{fresh} Nothing else has been done yet."
        return (
            f"{fresh} Earlier steps ran this code in the previous session:\n"
            f"{done}\n"
            f"Only the URL survived the reset; their other effects (a login, a "
            f"cart, filled fields) are gone. First redo whatever of that setup "
            f"this step depends on, WITHOUT reporting those statements in "
            f"step_done. Then perform this step and report only its own "
            f"statements."
        )

    if not history:
        return (
            f"Nothing has been done yet. The browser is on a blank page. "
            f"This test case starts at {module.url}."
        )
    return (
        f"The browser is live and earlier steps have already run exactly "
        f"this code:\n{done}\n"
        f"Do not repeat that work -- continue from the current page state. "
        f"This module's page is {module.url}."
    )


def to_execution_steps(
    module: Module, statements_by_step: list[list[StepStatement]]
) -> list[ExecutionStep]:
    """Rebuild `module`'s steps with their collected statements attached.

    Args:
        module: The module whose steps to rebuild.
        statements_by_step: One list of statements per execution step.

    Returns:
        The rebuilt execution steps.
    """
    return [
        ExecutionStep(step=step.step, statements=statements)
        for step, statements in zip(
            module.execution_steps, statements_by_step, strict=True
        )
    ]


def require_python(code: str, step: str) -> None:
    """Reject a statement that is not syntactically valid Python.

    Backstop for a tool that starts emitting JavaScript upstream but is still
    in `COLLECTABLE_TOOLS`: fail here, naming it, not in the generated script.

    Args:
        code: The collected statement.
        step: The step's text, for the error message.

    Raises:
        ExtractorError: If `code` does not parse as Python.
    """
    try:
        compile(code, "<collected>", "exec")
    except SyntaxError as exc:
        raise ExtractorError(
            f"Step {step!r} collected a statement that is not valid Python -- "
            f"the tool that emitted it ignores codegen python and must be "
            f"removed from COLLECTABLE_TOOLS:\n  {code}\n  ({exc})"
        ) from exc
