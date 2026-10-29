Write a complete, runnable pytest-playwright test module for the test case
below. Its browser steps have already been worked out and validated against
a live page: your job is to assemble them into a clean Python file.

TEST CASE NAME
{test_case_name}

FIXTURE (copy into the file exactly as given)
{fixture}

STEPS AND THEIR VALIDATED STATEMENTS
Each block is one step of the test case: the step's text, then the Python
statements that perform it, in order.

{steps}

WHAT THE FILE MUST CONTAIN, IN THIS ORDER
1. A module docstring: a short title line saying what the test verifies,
    then a blank line and one or two sentences of context.
2. The imports, and nothing else at the top. Import exactly what the file
    uses: `pytest` (for the fixture), `Page` (for the test's signature),
    `expect` if any statement uses it, and any other name a statement
    references. Import nothing that is not used.
3. The fixture, exactly as given above.
4. ONE test function:
    - Signature: `def <name>(page: Page) -> None:`.
    - Name: starts with `test_`, then lowercase snake_case describing the
        test (letters, digits, underscores only), at most 60 characters.
    - A one-sentence docstring describing what the test does.
    - The body: for every step, in the given order, a comment `# <step text>`
        followed by that step's statements, one per line. Leave one blank
        line between steps. For a step with no statements, write the step
        comment followed by `# (no browser interaction required)`.

RULES FOR THE STATEMENTS
- Copy every statement character for character. Do not edit, reformat,
    rename, reorder, merge, split or wrap them, and do not add or remove any.
    They are the validated part of the test; the file is rejected if one is
    missing or changed.
- Do not add any other code: no waits, retries, try/except, prints, helper
    functions, variables, assertions or setup.

STYLE
- Four-space indentation and double quotes, as in the statements.
- Keep every line you write within 88 characters; wrap long docstring
    sentences onto the next line. (Statements stay as given, whatever their
    length.)
- Two blank lines between the imports, the fixture and the test function.
- No comments other than the step comments.

EXAMPLE
For a test case "Login with valid credentials", a fixture for "en-US" and
the steps:

STEP: Open the login page
page.goto("https://example.com/login")

STEP: Check the page is shown
(no statements)

STEP: Verify the welcome message is visible
expect(page.get_by_text("Welcome back")).to_be_visible()

the file is:

"""Login with valid credentials.

Opens the login page and checks the welcome message is shown.
"""

import pytest
from playwright.sync_api import Page, expect


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args: dict) -> dict:
    """Pin the locale these locators were validated under."""
    return {{**browser_context_args, "locale": "en-US"}}


def test_login_with_valid_credentials(page: Page) -> None:
    """Open the login page and verify the welcome message is visible."""
    # Open the login page
    page.goto("https://example.com/login")

    # Check the page is shown
    # (no browser interaction required)

    # Verify the welcome message is visible
    expect(page.get_by_text("Welcome back")).to_be_visible()

OUTPUT
Return ONLY the Python source of the file: no Markdown code fences, no
explanation before or after it.
