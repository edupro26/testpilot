"""Tests for src.extractor.service."""

from src.extractor.mcp.server import McpResult
from src.extractor.service import Extractor
from src.llm.provider.mock import MockProvider, tool_turn
from src.model.test_case import ExecutionStep, Module

from test.extractor.fakes import FakeMCP, emitted

_CLICK = 'page.get_by_role("link", name="Signup / Login").click()'

_MODULE = Module(
    url="https://automationexercise.com/login",
    description="Login page",
    execution_steps=[
        ExecutionStep(step="Click Signup / Login"),
        ExecutionStep(step="Verify the login section is visible"),
    ],
)


def _run_step(index: int, history: list[str], reset_to: str | None = None) -> str:
    """Run one step against a fake that clicks; return the agent's prompt."""
    mcp = FakeMCP({"browser_click": McpResult(is_error=False, content=emitted(_CLICK))})
    llm = MockProvider(
        turns=[
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            tool_turn("step_done", {"statements": [{"code": _CLICK}]}, "c2"),
        ]
    )

    statements = Extractor(llm, mcp).run_step(
        _MODULE, index, history=history, reset_to=reset_to
    )

    assert [s.code for s in statements] == [_CLICK]
    return llm.conversations[0].user_prompt


def test_each_step_is_briefed_on_its_text_and_the_browser_state() -> None:
    """The agent drives one step and must know what the browser already shows.

    The first step starts on a blank page; a later step continues from live
    state; a retry after a reset only keeps the URL, so setup must be redone.
    """
    first = _run_step(0, history=[])
    assert "Click Signup / Login" in first
    assert "blank page" in first
    assert _MODULE.url in first

    later = _run_step(1, history=[_CLICK])
    assert "Verify the login section is visible" in later
    assert _CLICK in later
    assert "Do not repeat" in later

    retry = _run_step(1, history=[_CLICK], reset_to="https://example.com/x")
    assert "fresh session" in retry
    assert "https://example.com/x" in retry
    assert _CLICK in retry
    assert "WITHOUT reporting" in retry
    assert "Do not repeat" not in retry
