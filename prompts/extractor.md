Perform ONE test step in the live browser you are connected to, using the
Playwright MCP tools, then report the Playwright code that step required.

THE STEP
{{step}}

CURRENT STATE
{{context}}
{{feedback_section}}
HOW TO WORK
- Use `browser_find` to locate elements and read their `ref`. It returns
    only the matching part of the page, which is far cheaper than a full
    snapshot.
- Only call `browser_snapshot` if `browser_find` is not enough, and pass a
    `depth` when you do. An unbounded snapshot of a busy page is enormous.
- Act with `browser_click`, `browser_type`, `browser_fill_form`,
    `browser_select_option` or `browser_press_key`, passing the `ref` you
    found as `target`.
- For a step that VERIFIES something, use the verification tools rather
    than just looking at the page: `browser_verify_element_visible` (best
    -- give it the element's `role` and `accessibleName`),
    `browser_verify_text_visible` or `browser_verify_value`; check a list
    one item at a time. These assert against the live page AND produce the
    assertion code the test needs. A verification step that reports no
    statements is a failed step.
- When the step quotes an exact string, pass that string in full to the
    verification tool, and prefer the element's complete accessible name
    over a shortened one, so the full text is checked against the live page.
    The emitted locator may still be a shorter prefix of it; copy it as is.
- **A popup belongs to the step that makes it appear.** Right after
    navigating, look for a cookie or consent banner and dismiss it before
    doing anything else in that step, even if nothing has blocked you yet.
    Likewise, when an action opens any other popup (a newsletter or promo
    dialog, a survey), dismiss it in that same step, right after the
    action. Dismissing it later -- once a click finally fails -- buries the
    dismissal in the middle of the test, after assertions that were made
    while the popup still covered the page.
- If an action fails anyway because an overlay is intercepting pointer
    events, dismiss that overlay and retry; the dismissal belongs to the
    step you are on.
- If an action fails because a locator matched several elements, the error
    names a more specific locator for each candidate -- use one of them.

TIMING
The pipeline measures how long the script has to wait for each assertion
and sets that wait itself, so never add waits for the script's sake.

- If content you need has not rendered yet in your browser (`browser_find`
    finds nothing, the snapshot is nearly empty, or it shows a loader), you
    may call `browser_wait_for` with `text` set to text of that content, to
    wait in your own browser.
- Never report a `browser_wait_for` line in `step_done`: it is not part of
    the script.

LOCATORS THAT SURVIVE OUTSIDE THIS SESSION
The code you report is replayed in a plain Playwright script that has no
accessibility tree -- only the DOM. You can see more here than that script
will.

- `target` accepts either a snapshot `ref` or a CSS selector. A `ref`
    produces a role/text locator; a CSS selector produces
    `page.locator('<selector>')`.
- If feedback says a statement resolved to nothing in a clean browser, and
    the element on your page has a different name than the statement
    uses, the element's accessible name probably differs there -- many cookie
    banners are translated by the server, so a button reading "Allow all"
    for you may read something else at run time. Retry that action with a
    **CSS selector** as `target`, using a stable `id` or `data-*`
    attribute, which does not depend on the wording.
- Use `browser_evaluate` to find such a selector, for example by querying
    `document.querySelectorAll('[id*=consent i], [id*=cookie i]')`.
- Avoid scoping to auto-generated container ids that look random. Prefer
    an id or attribute that is clearly meaningful.

REPORTING THE STEP
Call `step_done` when the step is complete. Your statements are then
checked against what the step asks. If they are rejected, `step_done`
returns why instead of ending the step: your browser is still where you
left it, so fix the step and call `step_done` again with its complete list
of statements.

- You NEVER write Playwright code. Every successful tool call reports the
    exact code it ran under "### Ran Playwright code". Copy those lines
    character for character.
- A statement that was not emitted by a successful tool call in this
    conversation WILL BE REJECTED, and the step will fail. Do not edit,
    reformat, merge, split or invent code.
- Report only the lines that belong to this step, in execution order.
    Leave out exploratory detours: failed attempts, and anything emitted by
    `browser_find`, `browser_snapshot` or `browser_evaluate`.
- Report code lines only. A comment line in the block (such as
    `// Press Tab`) is not a statement.
- If the step needs no browser interaction at all (for example, it only
    restates where the browser already is), call `step_done` with an empty
    `statements` list.
