"""Generator service: turn a validated Level 2 test case into a script."""

import logging
import re

from crawl4ai.js_snippet import load_js_script

from src.exceptions import GeneratorError
from src.generator.frameworks import FRAMEWORK_TEMPLATES
from src.llm.protocol import LLMProvider
from src.model.enums import TestFramework
from src.model.test_case import TestCase
from src.prompt_loader import render_prompt

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = "You are an expert QA automation engineer."

# The exact snippet the Crawler runs (remove_overlay_elements=True) during
# Level 2, so the executed script's effective page matches what the
# Validator actually checked instead of drifting from crawl4ai's own logic.
_OVERLAY_JS = load_js_script("remove_overlay_elements")

_TEST_FN_RE = re.compile(r"^def test_", re.MULTILINE)
_MARKER_LINE_RE = re.compile(r"^[ \t]*# MODULE (\d+)[ \t]*$", re.MULTILINE)
_MARKER_BLOCK_RE = re.compile(
    r"^(?P<marker_indent>[ \t]*)# MODULE \d+[ \t]*\n"
    r"(?:(?:[ \t]*\n)*(?P<goto_indent>[ \t]*)(?P<goto>page\.goto\([^\n]*\))[ \t]*\n)?",
    re.MULTILINE,
)


class Generator:
    """Turns a validated Level 2 TestCase into an executable test script."""

    def __init__(self, llm: LLMProvider) -> None:
        """Initialize with the LLM provider to use.

        Args:
            llm: The LLM provider used to generate the script.
        """
        self._llm = llm

    def run(
        self,
        test_case: TestCase,
        *,
        framework: TestFramework = TestFramework.PLAYWRIGHT,
    ) -> str:
        """Generate a single executable test script for `test_case`.

        Args:
            test_case: The fully validated Level 2 test case (every
                execution step's extracted_data already populated and
                checked by the Validator).
            framework: The target test framework to generate a script for.

        Returns:
            The generated script source, as plain text, with overlay
            dismissal wired in right after each module's page is reached.

        Raises:
            GeneratorError: If the LLM response is empty, does not look
                like a test script, or is missing/misordered a module
                boundary marker needed to inject overlay dismissal.
        """
        logger.info(
            "Generating %s script for %r (%d module(s))",
            framework.value,
            test_case.name,
            len(test_case.modules),
        )

        prompt = render_prompt(
            FRAMEWORK_TEMPLATES[framework],
            test_case_json=test_case.model_dump_json(indent=2),
        )
        response = self._llm.complete(system_prompt=_SYSTEM_PROMPT, user_prompt=prompt)
        logger.debug("Raw LLM response (%d chars): %s", len(response), response)

        script = _strip_code_fence(response)
        _validate_looks_like_script(script)
        script = _inject_overlay_dismissal(script, len(test_case.modules))

        logger.info(
            "Generated %d char(s) of %s script for %r",
            len(script),
            framework.value,
            test_case.name,
        )
        return script


def _strip_code_fence(text: str) -> str:
    """Strip a wrapping Markdown code fence from `text`, if present.

    Args:
        text: The raw LLM response text.

    Returns:
        `text` with a leading ` ```lang` line and a trailing ` ``` ` line
        removed, and surrounding whitespace stripped. Left untouched
        (aside from stripping) if no fence is present.
    """
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped

    lines = stripped.splitlines()
    has_closing_fence = len(lines) > 1 and lines[-1].strip() == "```"
    lines = lines[1:-1] if has_closing_fence else lines[1:]
    return "\n".join(lines).strip()


def _validate_looks_like_script(script: str) -> None:
    """Raise GeneratorError unless `script` is non-empty and has a test function."""
    if not script:
        raise GeneratorError("LLM response was empty")
    if _TEST_FN_RE.search(script) is None:
        raise GeneratorError(
            "LLM response does not look like a test script "
            "(no 'def test_' function found)"
        )


def _inject_overlay_dismissal(script: str, module_count: int) -> str:
    """Replace each `# MODULE <i>` marker with a call dismissing overlays.

    Every module's page — whether reached via `page.goto()` or via a
    previous step's click — gets exactly one `_dismiss_overlays(page)`
    call right after it loads, mirroring the Crawler's own
    `remove_overlay_elements` behavior (see `src/extractor/crawler.py`).
    Relying on the LLM to remember this for every module would be
    fragile, so it's enforced deterministically instead.

    Args:
        script: The LLM-generated script, still carrying its raw
            `# MODULE <i>` markers.
        module_count: The expected number of markers (one per module).

    Returns:
        The script with every marker replaced by a dismissal call, and
        the `_dismiss_overlays` helper defined ahead of the test function.

    Raises:
        GeneratorError: If the markers aren't exactly `0..module_count-1`
            in order, or the resulting script doesn't end up with exactly
            `module_count` dismissal calls.
    """
    indices = [int(index) for index in _MARKER_LINE_RE.findall(script)]
    expected = list(range(module_count))
    if indices != expected:
        raise GeneratorError(
            f"expected one '# MODULE i' marker per module in order "
            f"{expected}, got {indices}"
        )

    script = _MARKER_BLOCK_RE.sub(_replace_marker, script)
    if script.count("_dismiss_overlays(page)") != module_count:
        raise GeneratorError("failed to inject overlay dismissal for every module")

    return _insert_overlay_helper(script)


def _replace_marker(match: re.Match[str]) -> str:
    """Replace one `_MARKER_BLOCK_RE` match with its overlay dismissal call.

    Keeps a captured `page.goto(...)` line in place, with the dismissal
    call right after it, so a module's page has actually loaded before
    dismissal runs against it.
    """
    goto = match.group("goto")
    if goto:
        indent = match.group("goto_indent")
        return f"{indent}{goto}\n{indent}_dismiss_overlays(page)\n"
    indent = match.group("marker_indent")
    return f"{indent}_dismiss_overlays(page)\n"


def _insert_overlay_helper(script: str) -> str:
    """Insert the `_dismiss_overlays` helper definition before the test function."""
    match = _TEST_FN_RE.search(script)
    helper = (
        f"_DISMISS_OVERLAYS_JS = {_OVERLAY_JS!r}\n\n\n"
        "def _dismiss_overlays(page: Page) -> None:\n"
        "    page.evaluate(_DISMISS_OVERLAYS_JS)\n\n\n"
    )
    return f"{script[: match.start()]}{helper}{script[match.start() :]}"
