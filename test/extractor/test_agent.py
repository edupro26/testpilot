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
_TAB = "await page.keyboard.press('Tab');"


def _done(*codes: str) -> ToolUseResponse:
    """Build a step_done turn reporting `codes` as the step's statements."""
    return tool_turn("step_done", {"statements": [{"code": c} for c in codes]}, "done")


class _SequencedMCP(FakeMCP):
    """Returns the given results in call order, whatever the tool."""

    def __init__(self, *results: McpResult) -> None:
        super().__init__()
        self._sequence = iter(results)

    def call_tool(self, name: str, arguments: dict) -> McpResult:
        self.calls.append((name, arguments))
        return next(self._sequence)


def test_drives_the_browser_recovers_and_collects_what_mcp_ran() -> None:
    """The overlay case, on a retry, with a non-collectable tool in the mix.

    A failed click, a dismissal, then a successful retry: both successful
    actions are collected. A JavaScript-emitting tool stays callable even
    though its code can never become a statement, and the retry feedback
    reaches the model.
    """
    mcp = _SequencedMCP(
        McpResult(is_error=False, content=emitted(_TAB)),
        McpResult(is_error=True, content="### Error\noverlay intercepts pointer"),
        McpResult(is_error=False, content=emitted(_CONSENT)),
        McpResult(is_error=False, content=emitted(_CLICK)),
    )
    llm = MockProvider(
        turns=[
            tool_turn("browser_press_key", {"key": "Tab"}),
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            tool_turn("browser_click", {"element": "consent", "target": "e2"}),
            tool_turn("browser_click", {"element": "link", "target": "e1"}),
            _done(_CONSENT, _CLICK),
        ]
    )

    statements = StepAgent(llm, mcp).run(
        "Click Signup / Login", context="fresh", feedback="clicked the wrong link"
    )

    assert [s.code for s in statements] == [_CONSENT, _CLICK]
    assert [name for name, _ in mcp.calls] == [
        "browser_press_key",
        "browser_click",
        "browser_click",
        "browser_click",
    ]
    conversation = llm.conversations[0]
    assert "clicked the wrong link" in conversation.user_prompt
    tools = {tool["name"] for tool in conversation.tools}
    assert {"step_done", "browser_verify_element_visible"} <= tools
    assert "browser_run_code_unsafe" not in tools


@pytest.mark.parametrize(
    ("tool", "ran", "reported", "match"),
    [
        pytest.param(
            "browser_click",
            _CLICK,
            "page.evaluate(\"fetch('/admin')\")",
            "no collectable",
            id="never-ran",
        ),
        pytest.param(
            "browser_click",
            _CLICK,
            'page.get_by_role("link", name="Signup").click()',
            "no collectable",
            id="edited",
        ),
        pytest.param(
            "browser_verify_text_visible",
            'expect(page.get_by_text("Your email or password is")).to_be_visible()',
            'expect(page.get_by_text("Your email or password is incorrect!"))'
            ".to_be_visible()",
            "no collectable",
            id="widened-truncated-locator",
        ),
        pytest.param(
            "browser_press_key", _TAB, _TAB, "no collectable", id="non-collectable"
        ),
        pytest.param(
            "browser_click",
            "await new Promise(f => setTimeout(f, 1 * 1000));",
            "await new Promise(f => setTimeout(f, 1 * 1000));",
            "not valid Python",
            id="not-python",
        ),
    ],
)
def test_rejects_a_statement_not_emitted_verbatim_by_a_collectable_tool(
    tool: str, ran: str, reported: str, match: str
) -> None:
    """The verbatim rule is enforced in code, not merely prompted."""
    mcp = FakeMCP({tool: McpResult(is_error=False, content=emitted(ran))})
    llm = MockProvider(turns=[tool_turn(tool, {}), _done(reported)])

    with pytest.raises(ExtractorError, match=match):
        StepAgent(llm, mcp).run("Do the step", context="fresh")


def test_the_loop_ends_only_through_step_done() -> None:
    """step_done may report nothing; never reporting it is an error."""
    idle = MockProvider(turns=[_done()])
    assert StepAgent(idle, FakeMCP()).run("Look", context="x") == []

    looping = MockProvider(
        turns=[tool_turn("browser_find", {"text": "x"}, f"c{i}") for i in range(10)]
    )
    with pytest.raises(ExtractorError, match="did not complete within"):
        StepAgent(looping, FakeMCP(), max_turns=3).run("Click something", context="x")

    chatty = MockProvider(turns=[ToolUseResponse(text="I am not sure how to proceed")])
    with pytest.raises(ExtractorError, match="stopped without calling"):
        StepAgent(chatty, FakeMCP()).run("Click something", context="x")
