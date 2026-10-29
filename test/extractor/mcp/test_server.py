"""Tests for src.extractor.mcp's offline parts: collecting and the allowlists."""

import pytest
from src.exceptions import McpError
from src.extractor.mcp.constants import ALLOWED_TOOLS, COLLECTABLE_TOOLS
from src.extractor.mcp.server import McpResult, PlaywrightMCP

from test.extractor.fakes import emitted

_CLICK = 'page.get_by_role("button", name="Consent").click()'


def test_collects_the_reported_playwright_code() -> None:
    """The emitted block is the only source of truth for a statement."""
    assert McpResult(is_error=False, content=emitted(_CLICK)).code == [_CLICK]


def test_collects_several_statements_from_one_call() -> None:
    """browser_fill_form reports one line per field."""
    fill = 'page.get_by_label("Email").fill("a@b.c")'

    collected = McpResult(is_error=False, content=emitted(fill, _CLICK)).code

    assert collected == [fill, _CLICK]


def test_a_failed_call_yields_no_code() -> None:
    """MCP only reports code it actually ran, so a failure collects nothing."""
    error = McpResult(is_error=True, content="### Error\noverlay intercepts clicks")

    assert error.code == []


def test_a_result_without_a_code_block_yields_no_code() -> None:
    """browser_find and browser_snapshot report findings, not actions."""
    assert McpResult(is_error=False, content="### Result\nFound 2 matches").code == []


def test_only_genuinely_unusable_tools_are_withheld() -> None:
    """A tool the agent cannot call is a capability it does not have."""
    assert "browser_run_code_unsafe" not in ALLOWED_TOOLS
    assert "browser_close" not in ALLOWED_TOOLS


def test_the_agent_keeps_the_javascript_emitting_tools() -> None:
    """They drive and inspect the browser; only their code is unusable."""
    for name in (
        "browser_press_key",
        "browser_navigate_back",
        "browser_wait_for",
        "browser_drag",
        "browser_evaluate",
        "browser_resize",
    ):
        assert name in ALLOWED_TOOLS
        assert name not in COLLECTABLE_TOOLS


def test_collectable_tools_are_a_subset_of_allowed_tools() -> None:
    """A tool that cannot be called cannot contribute code."""
    assert set(ALLOWED_TOOLS) >= COLLECTABLE_TOOLS


def test_the_interaction_and_assertion_tools_are_collectable() -> None:
    """These honour --codegen python, so they build the script."""
    for name in (
        "browser_navigate",
        "browser_click",
        "browser_hover",
        "browser_type",
        "browser_fill_form",
        "browser_select_option",
        "browser_verify_element_visible",
        "browser_verify_text_visible",
        "browser_verify_value",
        "browser_verify_list_visible",
    ):
        assert name in COLLECTABLE_TOOLS


def test_an_unreachable_server_raises_a_helpful_error() -> None:
    """The failure must name the fix, since nothing else can start the server."""
    with pytest.raises(McpError, match="npx @playwright/mcp"):
        PlaywrightMCP("http://localhost:9/mcp")
