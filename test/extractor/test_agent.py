"""Tests for src.extractor.agent."""

import pytest
from src.exceptions import ExtractorError
from src.extractor.agent import StepAgent
from src.extractor.mcp.server import McpResult
from src.llm.protocol import ToolUseResponse
from src.llm.provider.mock import MockProvider, tool_turn

from test.extractor.fakes import FakeMCP, emitted

_CLICK = 'page.get_by_role("link", name="Signup / Login").click()'
_CONSENT = 'page.get_by_role("button", name="Consent").click()'


def _done(*statements: dict, call_id: str = "c1") -> ToolUseResponse:
    """Build a step_done turn carrying `statements`."""
    return tool_turn("step_done", {"statements": list(statements)}, call_id)


def _statement(code: str) -> dict:
    return {"code": code}


def test_collects_the_code_mcp_actually_ran() -> None:
    """A statement MCP emitted is accepted and carried through."""
    mcp = FakeMCP({"browser_click": McpResult(is_error=False, content=emitted(_CLICK))})
    llm = MockProvider(
        turns=[
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            _done(_statement(_CLICK)),
        ]
    )

    statements = StepAgent(llm, mcp).run("Click Signup / Login", context="fresh")

    assert [s.code for s in statements] == [_CLICK]
    assert mcp.calls == [("browser_click", {"element": "link", "target": "e1"})]


def test_rejects_a_statement_mcp_never_ran() -> None:
    """The verbatim rule is enforced in code, not merely prompted."""
    mcp = FakeMCP({"browser_click": McpResult(is_error=False, content=emitted(_CLICK))})
    llm = MockProvider(
        turns=[
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            _done(_statement("page.evaluate(\"fetch('/admin')\")")),
        ]
    )

    with pytest.raises(ExtractorError, match="never"):
        StepAgent(llm, mcp).run("Click Signup / Login", context="fresh")


def test_rejects_an_edited_statement() -> None:
    """A near-miss is still a miss -- the locator must match character for character."""
    mcp = FakeMCP({"browser_click": McpResult(is_error=False, content=emitted(_CLICK))})
    llm = MockProvider(
        turns=[
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            _done(_statement('page.get_by_role("link", name="Signup").click()')),
        ]
    )

    with pytest.raises(ExtractorError):
        StepAgent(llm, mcp).run("Click Signup / Login", context="fresh")


def test_recovers_from_a_failed_action_and_collects_both_statements() -> None:
    """The overlay case: a failed click, a dismissal, then a successful retry."""
    results = iter(
        [
            McpResult(
                is_error=True,
                content="### Error\noverlay intercepts pointer events",
            ),
            McpResult(is_error=False, content=emitted(_CONSENT)),
            McpResult(is_error=False, content=emitted(_CLICK)),
        ]
    )

    class SequencedMCP(FakeMCP):
        def call_tool(self, name: str, arguments: dict) -> McpResult:
            self.calls.append((name, arguments))
            return next(results)

    mcp = SequencedMCP()
    llm = MockProvider(
        turns=[
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            tool_turn("browser_click", {"element": "consent", "target": "e2"}),
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            _done(_statement(_CONSENT), _statement(_CLICK)),
        ]
    )

    statements = StepAgent(llm, mcp).run("Click Signup / Login", context="fresh")

    assert [s.code for s in statements] == [_CONSENT, _CLICK]


def test_accepts_a_step_needing_no_interaction() -> None:
    """Some steps only restate where the browser already is."""
    llm = MockProvider(turns=[_done()])

    assert StepAgent(llm, FakeMCP()).run("Observe the page", context="fresh") == []


def test_errors_when_the_turn_cap_is_reached() -> None:
    """A model that never finishes is abandoned rather than looping forever."""
    llm = MockProvider(
        turns=[tool_turn("browser_find", {"text": "x"}, f"c{i}") for i in range(10)]
    )

    with pytest.raises(ExtractorError, match="did not complete within"):
        StepAgent(llm, FakeMCP(), max_turns=3).run("Click something", context="fresh")


def test_errors_when_the_model_stops_without_reporting() -> None:
    """A text-only reply means the step was never reported complete."""
    llm = MockProvider(turns=[ToolUseResponse(text="I am not sure how to proceed")])

    with pytest.raises(ExtractorError, match="stopped without calling"):
        StepAgent(llm, FakeMCP()).run("Click something", context="fresh")


def test_feedback_reaches_the_prompt_on_a_retry() -> None:
    """Retry feedback must be visible to the model, or the retry is blind."""
    llm = MockProvider(turns=[_done()])

    StepAgent(llm, FakeMCP()).run(
        "Verify the error", context="fresh", feedback="asserted the wrong element"
    )

    assert "asserted the wrong element" in llm.conversations[0].user_prompt


def test_step_done_is_offered_alongside_the_mcp_tools() -> None:
    """The model cannot finish a step without the reporting tool."""
    llm = MockProvider(turns=[_done()])

    StepAgent(llm, FakeMCP()).run("Click something", context="fresh")

    names = {tool["name"] for tool in llm.conversations[0].tools}
    assert "step_done" in names
    assert "browser_verify_element_visible" in names
    assert "browser_run_code_unsafe" not in names


def test_rejects_a_statement_that_is_not_valid_python() -> None:
    """Backstop against a tool that ignores --codegen python."""
    javascript = "await new Promise(f => setTimeout(f, 1 * 1000));"
    mcp = FakeMCP(
        {"browser_click": McpResult(is_error=False, content=emitted(javascript))}
    )
    llm = MockProvider(
        turns=[
            tool_turn("browser_click", {"element": "x", "target": "e1"}),
            _done(_statement(javascript)),
        ]
    )

    with pytest.raises(ExtractorError, match="not valid Python"):
        StepAgent(llm, mcp).run("Wait a second", context="fresh")


def test_code_from_a_non_collectable_tool_cannot_become_a_statement() -> None:
    """browser_press_key drives the UI but emits JavaScript."""
    javascript = "await page.keyboard.press('Tab');"
    mcp = FakeMCP(
        {"browser_press_key": McpResult(is_error=False, content=emitted(javascript))}
    )
    llm = MockProvider(
        turns=[
            tool_turn("browser_press_key", {"key": "Tab"}),
            _done(_statement(javascript)),
        ]
    )

    with pytest.raises(ExtractorError):
        StepAgent(llm, mcp).run("Press Tab", context="fresh")


def test_a_non_collectable_tool_can_still_be_called() -> None:
    """Withholding the tool would cost the agent a real capability."""
    mcp = FakeMCP(
        {
            "browser_press_key": McpResult(
                is_error=False, content=emitted("await page.keyboard.press('Tab');")
            ),
            "browser_click": McpResult(is_error=False, content=emitted(_CLICK)),
        }
    )
    llm = MockProvider(
        turns=[
            tool_turn("browser_press_key", {"key": "Tab"}),
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            _done(_statement(_CLICK)),
        ]
    )

    statements = StepAgent(llm, mcp).run("Press Tab then click", context="fresh")

    assert [s.code for s in statements] == [_CLICK]
    assert ("browser_press_key", {"key": "Tab"}) in mcp.calls


def test_a_shortened_assertion_is_collected_as_emitted() -> None:
    """Playwright shortens long locator text; the line is kept verbatim."""
    short = 'expect(page.get_by_text("Your email or password is")).to_be_visible()'
    widened = (
        'expect(page.get_by_text("Your email or password is incorrect!"))'
        ".to_be_visible()"
    )
    mcp = FakeMCP(
        {
            "browser_verify_text_visible": McpResult(
                is_error=False, content=emitted(short)
            )
        }
    )
    verify = tool_turn(
        "browser_verify_text_visible", {"text": "Your email or password is incorrect!"}
    )

    accepted = StepAgent(MockProvider(turns=[verify, _done(_statement(short))]), mcp)
    assert [s.code for s in accepted.run("Verify the error", context="x")] == [short]

    rejected = StepAgent(MockProvider(turns=[verify, _done(_statement(widened))]), mcp)
    with pytest.raises(ExtractorError, match="never"):
        rejected.run("Verify the error", context="x")
