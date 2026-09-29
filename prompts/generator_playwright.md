You are an expert QA automation engineer. Given the fully validated Level 2
JSON test case below, generate a single executable Playwright (Python) test
file that uses the `pytest-playwright` sync `page` fixture.

OBJECTIVE
- Produce one pytest test function that performs every execution step, of
    every module, in order, using the `page` fixture pytest-playwright
    injects automatically.
- The file must be self-contained and ready to run with `pytest` as-is —
    do not define your own fixtures, config, or `if __name__ == "__main__"`
    block.

RULES
- File contents:
    - Start with `from playwright.sync_api import Page, expect`.
    - Define exactly one function: `def test_<snake_case_name>(page: Page)
        -> None:`, where `<snake_case_name>` is the test case's "name"
        converted to snake_case, ASCII, lowercase.
    - No other top-level code, functions, or classes.
- Module markers: immediately before the code for each module's first
    step, and nowhere else, insert a standalone comment line reading
    exactly `# MODULE <index>`, where `<index>` is that module's 0-based
    position in the "modules" array below (`# MODULE 0` before module 0's
    first step, `# MODULE 1` before module 1's, and so on). Emit exactly
    one marker per module, in order, with no blank line between the
    marker and the code that follows it — even for a module reached only
    through a previous step's click, which has no `page.goto()` of its
    own. These markers are replaced by generation post-processing; never
    explain or otherwise reference them.
- Navigation: call `page.goto("<url>")` only for a step whose text
    explicitly asks to launch/open/navigate to a URL. Do not call
    `page.goto` again for a module reached only through a previous step's
    click or form submission — that navigation already happened in the
    browser.
- Overlay dismissal: never write your own cookie-consent or popup-closing
    code (e.g. clicking an "Accept" button) — that is injected
    automatically at every `# MODULE <index>` marker. Focus only on the
    execution steps themselves.
- Locators: build a locator for each "extracted_data" entry as
    `page.locator("{{identifier_type}}={{identifier_tracking}}")` —
    Playwright's engine-prefixed selector syntax accepts every
    "identifier_type" value ("id=", "css=", "xpath=", "text=") directly,
    so no translation is needed. Note that "text=" matches on normalized,
    case-insensitive substring by default.
- Actions: infer the action from the step's wording and the element's
    "type":
    - "button" / "link": `.click()`
    - "input": `.fill("<input_value>")`, using that entry's "input_value"
        field verbatim — it was already decided earlier in the pipeline.
        Only if "input_value" is null (should not normally happen for a
        fill step) invent a plausible literal consistent with
        "request_description".
    - "checkbox": `.check()` or `.uncheck()` matching the step's intent.
    - "dropdown": `.select_option("<input_value>")`, same "input_value"
        rule as "input".
    - "text" / "other" used in a verification step: assert with
        `expect(<locator>).to_contain_text("<expected text>")` when the
        step quotes exact expected text, else
        `expect(<locator>).to_be_visible()`.
- A step with an empty "extracted_data" that is not a navigation step is a
    generic visibility check with no specific element to locate (e.g.
    "Verify the home page is visible"). Assert
    `expect(page.locator("body")).to_be_visible()` for it — never invent a
    selector that was not extracted, and never assert on the page's URL
    (redirects make exact URL assertions unreliable).
- Preserve step order across modules exactly as given; do not skip, merge,
    or reorder steps.

Return ONLY the Python source code, no code fences, no commentary, no
markdown.

Level 2 test case:
{test_case_json}
