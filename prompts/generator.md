Write a complete, runnable Playwright Test (`@playwright/test`) spec file for
the test case below. Its browser steps have already been worked out and
validated against a live page: your job is to assemble them into a clean
TypeScript file.

TEST CASE NAME
{{test_case_name}}

LOCALE SETTING (copy into the file exactly as given)
{{locale_setting}}

STEPS AND THEIR VALIDATED STATEMENTS
Each block is one step of the test case: the step's text, then the
TypeScript statements that perform it, in order.

{{steps}}

WHAT THE FILE MUST CONTAIN, IN THIS ORDER
1. A file header comment: a `/** ... */` block with a short title line
    saying what the test verifies, then a blank comment line and one or two
    sentences of context.
2. The import, and nothing else at the top. Import exactly what the file
    uses from `@playwright/test`: `test`, and `expect` if any statement uses
    it. Import nothing that is not used.
3. The locale setting, exactly as given above.
4. ONE test:
    - Directly above it, a one-sentence `/** ... */` comment describing
        what the test does.
    - Form: `test('<title>', async ({ page }) => { ... });`.
    - Title: a short, plain-English description of the test, at most 60
        characters, starting with a capital letter and with no trailing
        period.
    - The body: for every step, in the given order, a comment `// <step text>`
        followed by that step's statements, one per line. Leave one blank
        line between steps. For a step with no statements, write the step
        comment followed by `// (no browser interaction required)`.

RULES FOR THE STATEMENTS
- Copy every statement character for character. Do not edit, reformat,
    rename, reorder, merge, split or wrap them, and do not add or remove any.
    They are the validated part of the test; the file is rejected if one is
    missing or changed.
- Do not add any other code: no waits, retries, try/catch, console logs,
    helper functions, variables, assertions or setup.

STYLE
- Two-space indentation, single quotes and semicolons, as in the statements.
- Keep every line you write within 88 characters; wrap long comment
    sentences onto the next line. (Statements stay as given, whatever their
    length.)
- One blank line between the header comment, the import, the locale setting
    and the test.
- No comments other than the header, the test's comment and the step
    comments.

EXAMPLE
For a test case "Login with valid credentials", the locale setting
`test.use({ locale: 'en-US' });` and the steps:

STEP: Open the login page
await page.goto('https://example.com/login');

STEP: Check the page is shown
(no statements)

STEP: Verify the welcome message is visible
await expect(page.getByText('Welcome back')).toBeVisible();

the file is:

/**
 * Login with valid credentials.
 *
 * Opens the login page and checks the welcome message is shown.
 */

import { expect, test } from '@playwright/test';

test.use({ locale: 'en-US' });

/** Open the login page and verify the welcome message is visible. */
test('Login with valid credentials', async ({ page }) => {
  // Open the login page
  await page.goto('https://example.com/login');

  // Check the page is shown
  // (no browser interaction required)

  // Verify the welcome message is visible
  await expect(page.getByText('Welcome back')).toBeVisible();
});

OUTPUT
Return ONLY the TypeScript source of the file: no Markdown code fences, no
explanation before or after it.
