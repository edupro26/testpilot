"""Tests for src.generator.service."""

import pytest
from src.exceptions import GeneratorError
from src.generator.service import Generator
from src.llm.provider.mock import MockProvider
from src.model.test_case import ExecutionStep, Module, StepStatement, TestCase

_CONSENT = 'page.get_by_role("button", name="Consent").click()'
_CLICK = 'page.get_by_role("link", name="Signup / Login").click()'
_ASSERT = 'expect(page.get_by_role("heading", name="Login")).to_be_visible()'

_TEST_CASE = TestCase(
    name="Login User with Incorrect Credentials",
    modules=[
        Module(
            url="https://automationexercise.com",
            description="Home page",
            execution_steps=[
                ExecutionStep(
                    step="Navigate and open the login page",
                    statements=[
                        StepStatement(code=_CONSENT),
                        StepStatement(code=_CLICK),
                    ],
                ),
                ExecutionStep(step="Observe the page", statements=[]),
                ExecutionStep(
                    step="Verify the login section is visible",
                    statements=[StepStatement(code=_ASSERT)],
                ),
            ],
        )
    ],
)


def _script(locale: str = "en-US", body: str | None = None) -> str:
    """A well-formed script, as the LLM is asked to write it."""
    body = body or (
        "    # Navigate and open the login page\n"
        f"    {_CONSENT}\n"
        f"    {_CLICK}\n"
        "\n"
        "    # Observe the page\n"
        "    # (no browser interaction required)\n"
        "\n"
        "    # Verify the login section is visible\n"
        f"    {_ASSERT}\n"
    )
    return (
        '"""Login with incorrect credentials."""\n'
        "\n"
        "import pytest\n"
        "from playwright.sync_api import Page, expect\n"
        "\n"
        "\n"
        '@pytest.fixture(scope="session")\n'
        "def browser_context_args(browser_context_args: dict) -> dict:\n"
        '    """Pin the locale these locators were validated under."""\n'
        f'    return {{**browser_context_args, "locale": "{locale}"}}\n'
        "\n"
        "\n"
        "def test_login_with_incorrect_credentials(page: Page) -> None:\n"
        '    """Log in with a wrong password and see the login section."""\n'
        f"{body}"
    )


def test_assembles_the_validated_steps_into_the_llm_script() -> None:
    """The LLM gets every validated piece verbatim and its file is returned.

    A Markdown fence around the code must not end up in the file.
    """
    seen: dict[str, str] = {}

    def capture(_system: str, user: str) -> str:
        seen["prompt"] = user
        return f"```python\n{_script(locale='pt-PT')}```"

    script = Generator(MockProvider(capture), locale="pt-PT").run(_TEST_CASE)

    assert script == _script(locale="pt-PT")
    compile(script, "<generated>", "exec")

    prompt = seen["prompt"]
    for step in _TEST_CASE.modules[0].execution_steps:
        assert f"STEP: {step.step}" in prompt
    for code in (_CONSENT, _CLICK, _ASSERT):
        assert code in prompt
    assert "(no statements)" in prompt
    assert "def browser_context_args" in prompt
    assert '"locale": "pt-PT"' in prompt


@pytest.mark.parametrize(
    ("reply", "match"),
    [
        pytest.param(
            _script(body=f"    {_CONSENT}\n    {_ASSERT}\n"),
            "Signup / Login",
            id="dropped-statement",
        ),
        pytest.param(
            _script(
                body=f"    {_CONSENT}\n"
                f"    {_CLICK.replace('.click()', '.click(force=True)')}\n"
                f"    {_ASSERT}\n"
            ),
            "altered",
            id="altered-statement",
        ),
        pytest.param(
            _script(body=f"    {_CLICK}\n    {_CONSENT}\n    {_ASSERT}\n"),
            "dropped or altered",
            id="reordered-statements",
        ),
        pytest.param(_script(locale="pt-PT"), "en-US", id="changed-fixture"),
        pytest.param(
            _script() + "def broken(:\n", "does not compile", id="does-not-compile"
        ),
    ],
)
def test_rejects_a_script_that_is_not_exactly_what_was_validated(
    reply: str, match: str
) -> None:
    """What was validated, in order and under its locale, is what ships."""
    with pytest.raises(GeneratorError, match=match):
        Generator(MockProvider(reply)).run(_TEST_CASE)


def test_rejects_a_test_case_with_no_statements() -> None:
    """An empty script would pass pytest while testing nothing."""
    empty = TestCase(
        name="Empty",
        modules=[
            Module(
                url="https://example.com",
                description="d",
                execution_steps=[ExecutionStep(step="Do nothing")],
            )
        ],
    )

    with pytest.raises(GeneratorError, match="no validated statements"):
        Generator(MockProvider(_script())).run(empty)
