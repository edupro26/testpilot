"""Tests for src.extractor.mcp's offline parts: collecting and the allowlists."""

import pytest
from src.exceptions import McpError
from src.extractor.mcp.constants import ALLOWED_TOOLS, COLLECTABLE_TOOLS
from src.extractor.mcp.server import McpResult, PlaywrightMCP

from test.extractor.fakes import emitted

_CLICK = 'page.get_by_role("button", name="Consent").click()'


def test_only_the_reported_playwright_code_of_a_successful_call_is_collected() -> None:
    """The emitted block is the only source of truth for a statement.

    browser_fill_form reports one line per field; a failure or a findings-only
    result (browser_find, browser_snapshot) collects nothing.
    """
    fill = 'page.get_by_label("Email").fill("a@b.c")'

    assert McpResult(is_error=False, content=emitted(fill, _CLICK)).code == [
        fill,
        _CLICK,
    ]
    assert McpResult(is_error=True, content="### Error\noverlay intercepts").code == []
    assert McpResult(is_error=False, content="### Result\nFound 2 matches").code == []


def test_the_tool_allowlists() -> None:
    """Only unusable tools are withheld; only Python-emitting ones are collected.

    JavaScript-emitting tools still drive and inspect the browser, so the
    agent keeps them -- their code just never becomes a statement.
    """
    assert "browser_run_code_unsafe" not in ALLOWED_TOOLS
    assert "browser_close" not in ALLOWED_TOOLS
    assert set(ALLOWED_TOOLS) >= COLLECTABLE_TOOLS

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

    assert {
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
    } <= COLLECTABLE_TOOLS


def test_an_unreachable_server_raises_a_helpful_error() -> None:
    """The failure must name the fix, since nothing else can start the server."""
    with pytest.raises(McpError, match="npx @playwright/mcp"):
        PlaywrightMCP("http://localhost:9/mcp")
