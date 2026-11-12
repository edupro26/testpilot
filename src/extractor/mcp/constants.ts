/** Constants for the Playwright MCP client: timeouts, tool lists, code pattern. */

export const CONNECT_TIMEOUT_MS = 60_000;
export const CALL_TIMEOUT_MS = 180_000;

// The exact code MCP ran for a successful call. TypeScript codegen fences it
// as `js`.
export const CODE_BLOCK = /### Ran Playwright code\n```js\n([\s\S]*?)\n```/;

// Every tool the agent may call. Withheld: browser_run_code_unsafe (RCE in the
// server process), browser_close (kills the session the pipeline owns) and
// browser_verify_list_visible (its aria snapshot spans several lines, and a
// statement must fit on one).
export const ALLOWED_TOOLS: readonly string[] = [
    'browser_navigate',
    'browser_navigate_back',
    'browser_snapshot',
    'browser_find',
    'browser_click',
    'browser_hover',
    'browser_drag',
    'browser_drop',
    'browser_select_option',
    'browser_type',
    'browser_press_key',
    'browser_fill_form',
    'browser_evaluate',
    'browser_wait_for',
    'browser_take_screenshot',
    'browser_handle_dialog',
    'browser_file_upload',
    'browser_console_messages',
    'browser_network_requests',
    'browser_network_request',
    'browser_tabs',
    'browser_resize',
    'browser_emulate_media',
    'browser_generate_locator',
    'browser_verify_element_visible',
    'browser_verify_text_visible',
    'browser_verify_value',
];

// The subset whose emitted code may enter the script: the test's actions and
// assertions, each a self-contained line. The others explore (snapshot, find,
// evaluate, screenshots, logs), change the environment rather than the page
// (resize, emulate_media), emit code that depends on a variable from an
// earlier line (file_upload, handle_dialog, tabs, drop), or wait in the
// agent's browser only (wait_for: the script's timing is measured instead).
export const COLLECTABLE_TOOLS: ReadonlySet<string> = new Set([
    'browser_navigate',
    'browser_navigate_back',
    'browser_click',
    'browser_hover',
    'browser_drag',
    'browser_type',
    'browser_press_key',
    'browser_fill_form',
    'browser_select_option',
    'browser_verify_element_visible',
    'browser_verify_text_visible',
    'browser_verify_value',
]);
