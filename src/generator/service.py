"""Generator service: have the LLM assemble a validated test case into a script.

The validated statements and the locale fixture are injected into the prompt
and must come back unchanged; the LLM writes everything around them.
"""

import logging

from src.exceptions import GeneratorError
from src.llm.protocol import LLMProvider
from src.model.test_case import TestCase
from src.prompt_loader import render_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."

_FIXTURE = '''@pytest.fixture(scope="session")
def browser_context_args(browser_context_args: dict) -> dict:
    """Pin the locale these locators were validated under."""
    return {{**browser_context_args, "locale": "{locale}"}}'''


class Generator:
    """Assembles a validated TestCase into an executable script."""

    def __init__(self, llm: LLMProvider, *, locale: str = "en-US") -> None:
        """Initialize with the LLM provider to use.

        Args:
            llm: Writes the script around the validated statements.
            locale: The context locale the statements were validated
                under, pinned in the generated script so it reproduces.
        """
        self._llm = llm
        self._locale = locale

    def run(self, test_case: TestCase) -> str:
        """Assemble `test_case` into an executable Playwright test script.

        Args:
            test_case: The fully validated test case.

        Returns:
            The generated script source.

        Raises:
            GeneratorError: If the test case carries no statements, or the
                LLM's script does not compile or drops or alters a validated
                statement or the fixture.
        """
        statements = [
            statement.code
            for module in test_case.modules
            for step in module.execution_steps
            for statement in step.statements
        ]
        if not statements:
            raise GeneratorError(
                f"{test_case.name!r} has no validated statements to assemble"
            )

        logger.info(
            "Assembling script for %r (%d statement(s))",
            test_case.name,
            len(statements),
        )

        fixture = _FIXTURE.format(locale=self._locale)
        steps = "\n\n".join(
            "\n".join([f"STEP: {step.step}", *[s.code for s in step.statements]])
            if step.statements
            else f"STEP: {step.step}\n(no statements)"
            for module in test_case.modules
            for step in module.execution_steps
        )
        response = self._llm.complete(
            system_prompt=_SYSTEM_PROMPT,
            user_prompt=render_prompt(
                "generator",
                test_case_name=test_case.name,
                fixture=fixture,
                steps=steps,
            ),
        )
        script = _strip_fence(response).strip() + "\n"

        try:
            compile(script, "<generated>", "exec")
        except SyntaxError as exc:
            raise GeneratorError(f"Generated script does not compile: {exc}") from exc

        missing = _missing_lines(script, [*fixture.splitlines(), *statements])
        if missing:
            raise GeneratorError(
                "Generated script dropped or altered validated code:\n"
                + "\n".join(f"  {line}" for line in missing)
            )

        logger.info("Assembled %d char(s) of script", len(script))
        return script


def _strip_fence(text: str) -> str:
    """Remove a surrounding Markdown code fence, if the LLM added one."""
    lines = text.strip().splitlines()
    if lines and lines[0].startswith("```") and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1])
    return text


def _missing_lines(script: str, required: list[str]) -> list[str]:
    """Return the `required` lines not found, in order, in `script`."""
    lines = [line.strip() for line in script.splitlines()]
    missing, position = [], 0
    for wanted in (line.strip() for line in required if line.strip()):
        try:
            position = lines.index(wanted, position) + 1
        except ValueError:
            missing.append(wanted)
    return missing
