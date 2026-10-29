"""Constants for the Playwright MCP client: timeouts, tool lists, code pattern."""

import re

CONNECT_TIMEOUT_SECONDS = 60.0
CALL_TIMEOUT_SECONDS = 180.0
SHUTDOWN_TIMEOUT_SECONDS = 30.0

# The exact code MCP ran for a successful call
CODE_BLOCK = re.compile(r"### Ran Playwright code\n```python\n(.*?)\n```", re.DOTALL)

# Every tool the agent may call. Withheld: browser_run_code_unsafe (RCE in the
# server process) and browser_close (kills the session the pipeline owns).
ALLOWED_TOOLS = (
    "browser_navigate",
    "browser_navigate_back",
    "browser_snapshot",
    "browser_find",
    "browser_click",
    "browser_hover",
    "browser_drag",
    "browser_drop",
    "browser_select_option",
    "browser_type",
    "browser_press_key",
    "browser_fill_form",
    "browser_evaluate",
    "browser_wait_for",
    "browser_take_screenshot",
    "browser_handle_dialog",
    "browser_file_upload",
    "browser_console_messages",
    "browser_network_requests",
    "browser_network_request",
    "browser_tabs",
    "browser_resize",
    "browser_emulate_media",
    "browser_generate_locator",
    "browser_verify_element_visible",
    "browser_verify_text_visible",
    "browser_verify_list_visible",
    "browser_verify_value",
)

# The subset whose emitted code is Python and may enter the script. The other
# tools still drive the browser but emit JavaScript whatever `codegen` says
COLLECTABLE_TOOLS = frozenset(
    {
        "browser_navigate",
        "browser_click",
        "browser_hover",
        "browser_type",
        "browser_fill_form",
        "browser_select_option",
        "browser_verify_element_visible",
        "browser_verify_text_visible",
        "browser_verify_list_visible",
        "browser_verify_value",
    }
)
