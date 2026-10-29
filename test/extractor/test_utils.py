"""Tests for src.extractor.utils."""

import pytest
from src.exceptions import ExtractorError
from src.extractor.utils import require_python, to_execution_steps
from src.model.test_case import ExecutionStep, Module, StepStatement

_CLICK = 'page.get_by_role("link", name="Signup / Login").click()'

_MODULE = Module(
    url="https://automationexercise.com/login",
    description="Login page",
    execution_steps=[
        ExecutionStep(step="Click Signup / Login"),
        ExecutionStep(step="Verify the login section is visible"),
    ],
)


def test_to_execution_steps_pairs_statements_with_their_steps() -> None:
    """Rebuilding the module must not shift statements onto the wrong step."""
    first = [StepStatement(code=_CLICK)]

    steps = to_execution_steps(_MODULE, [first, []])

    assert steps[0].step == "Click Signup / Login"
    assert steps[0].statements == first
    assert steps[1].statements == []


def test_require_python_accepts_a_python_statement() -> None:
    """Emitted Python passes untouched."""
    require_python(_CLICK, "Click Signup / Login")


def test_require_python_rejects_javascript() -> None:
    """A tool that emits JavaScript must fail at extraction, naming the line."""
    with pytest.raises(ExtractorError, match="not valid Python"):
        require_python("await page.keyboard.press('Tab');", "Press Tab")
