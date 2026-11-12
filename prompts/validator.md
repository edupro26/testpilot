Judge whether the Playwright code below actually accomplishes the test
step it was produced for.

The code has ALREADY been proven to execute: it just ran in a live browser
without error, every locator resolved to exactly one element, and every
assertion passed. Do not re-check any of that -- you cannot see the page,
and it is settled.

Your only question is semantic: does this code do what the step asked?

THE STEP
{{step}}

THE CODE (one numbered entry per statement)
{{code}}

WHERE THE BROWSER ENDED UP
- URL: {{page_url}}
- Title: {{page_title}}

REJECT the code only for a substantive mismatch, such as:
- it verifies something other than what the step asked to verify (for
    example the step asks for an error message and the code asserts a
    heading is visible);
- it acts on the wrong element (clicks "Signup" where the step says
    "Login");
- it fills a value the step did not ask for;
- the step requires a verification and the code only performs actions,
    asserting nothing;
- there is no code, and the step asks for an action or a verification.

ACCEPT the code when it accomplishes the step. In particular, do NOT
reject it for:
- using a different locator strategy than you would have chosen;
- scoping a locator more narrowly than seems necessary;
- an accessible name carrying odd whitespace or icon characters;
- including the dismissal of a cookie banner or other popup;
- a text or accessible-name locator that is a shortened prefix of the text
    the step quotes (for example `getByText('Your email or password is')`
    for "Your email or password is incorrect!"). Playwright shortens long
    text in the locators it generates, and the full text was already checked
    against the live page when this code was produced;
- being shorter than you expected, when it still does the job;
- having no code, when the step needs nothing done in the browser.

OUTPUT SCHEMA
{"is_valid": true, "reason": "...", "statement_reasons": ["...", "..."]}

- `reason` must be brief. When rejecting, it must be specific enough to fix
    the step on a retry.
- When accepting, `statement_reasons` holds exactly one entry per numbered
    statement, in order: one compact sentence on why that line was accepted
    for the step (for example, "Clicks the 'Login' button the step asks
    for."). When rejecting, leave it empty.

Return ONLY valid JSON, no code fences or commentary.
