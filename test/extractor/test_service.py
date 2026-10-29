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


def _mcp() -> FakeMCP:
    """A fake that reports running the click, so collecting succeeds."""
    return FakeMCP(
        {"browser_click": McpResult(is_error=False, content=emitted(_CLICK))}
    )


def _llm() -> MockProvider:
    return MockProvider(
        turns=[
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            tool_turn(
                "step_done",
                {"statements": [{"code": _CLICK}]},
                "c2",
            ),
        ]
    )


def test_runs_a_step_and_returns_its_statements() -> None:
    """One step at a time, so the Validator can prove each before the next."""
    statements = Extractor(_llm(), _mcp()).run_step(_MODULE, 0, history=[])

    assert [s.code for s in statements] == [_CLICK]


def test_the_first_step_is_told_the_browser_is_blank() -> None:
    """Without this the agent may assume a page is already open."""
    llm = _llm()

    Extractor(llm, _mcp()).run_step(_MODULE, 0, history=[])

    prompt = llm.conversations[0].user_prompt
    assert "blank page" in prompt
    assert _MODULE.url in prompt


def test_a_later_step_is_told_what_already_ran() -> None:
    """The agent must continue from live state, not redo earlier steps."""
    llm = _llm()

    Extractor(llm, _mcp()).run_step(_MODULE, 1, history=[_CLICK])

    prompt = llm.conversations[0].user_prompt
    assert _CLICK in prompt
    assert "Do not repeat" in prompt


def test_a_retry_after_a_reset_is_told_the_earlier_state_is_gone() -> None:
    """After a reset only the URL survives, so the setup must be redone."""
    llm = _llm()

    Extractor(llm, _mcp()).run_step(
        _MODULE, 1, history=[_CLICK], reset_to="https://example.com/x"
    )

    prompt = llm.conversations[0].user_prompt
    assert "fresh session" in prompt
    assert "https://example.com/x" in prompt
    assert _CLICK in prompt
    assert "WITHOUT reporting" in prompt
    assert "Do not repeat" not in prompt


def test_the_step_text_reaches_the_agent() -> None:
    """The agent is driving one specific step, not the whole module."""
    llm = _llm()

    Extractor(llm, _mcp()).run_step(_MODULE, 1, history=[_CLICK])

    assert "Verify the login section is visible" in llm.conversations[0].user_prompt
