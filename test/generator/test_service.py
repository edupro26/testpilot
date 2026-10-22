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


def test_returns_the_llm_script() -> None:
    """The LLM assembles the file; a well-formed one is returned as is."""
    script = Generator(MockProvider(_script())).run(_TEST_CASE)

    assert script == _script()
    compile(script, "<generated>", "exec")


def test_the_prompt_carries_the_steps_statements_and_fixture() -> None:
    """The LLM needs every validated piece, verbatim, to assemble the file."""
    seen: dict[str, str] = {}

    def capture(_system: str, user: str) -> str:
        seen["prompt"] = user
        return _script(locale="pt-PT")

    Generator(MockProvider(capture), locale="pt-PT").run(_TEST_CASE)

    prompt = seen["prompt"]
    for step in _TEST_CASE.modules[0].execution_steps:
        assert f"STEP: {step.step}" in prompt
    for code in (_CONSENT, _CLICK, _ASSERT):
        assert code in prompt
    assert "(no statements)" in prompt
    assert "def browser_context_args" in prompt
    assert '"locale": "pt-PT"' in prompt


def test_a_fenced_reply_is_unwrapped() -> None:
    """A Markdown fence around the code must not end up in the file."""
    fenced = f"```python\n{_script()}```"

    assert Generator(MockProvider(fenced)).run(_TEST_CASE) == _script()


def test_a_dropped_statement_is_rejected() -> None:
    """What was validated is what ships, or the run fails."""
    body = f"    {_CONSENT}\n    {_ASSERT}\n"

    with pytest.raises(GeneratorError, match="Signup / Login"):
        Generator(MockProvider(_script(body=body))).run(_TEST_CASE)


def test_an_altered_statement_is_rejected() -> None:
    """Even a small edit means the shipped line was never validated."""
    body = (
        f"    {_CONSENT}\n"
        f"    {_CLICK.replace('.click()', '.click(force=True)')}\n"
        f"    {_ASSERT}\n"
    )

    with pytest.raises(GeneratorError, match="altered"):
        Generator(MockProvider(_script(body=body))).run(_TEST_CASE)


def test_reordered_statements_are_rejected() -> None:
    """Statements depend on each other, so their order is part of the proof."""
    body = f"    {_CLICK}\n    {_CONSENT}\n    {_ASSERT}\n"

    with pytest.raises(GeneratorError):
        Generator(MockProvider(_script(body=body))).run(_TEST_CASE)


def test_a_missing_or_changed_fixture_is_rejected() -> None:
    """The locale fixture is what makes the locators reproduce at run time."""
    with pytest.raises(GeneratorError, match="en-US"):
        Generator(MockProvider(_script(locale="pt-PT"))).run(_TEST_CASE)


def test_a_script_that_does_not_compile_is_rejected() -> None:
    """A broken file must fail here, not later under pytest."""
    with pytest.raises(GeneratorError, match="does not compile"):
        Generator(MockProvider(_script() + "def broken(:\n")).run(_TEST_CASE)


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
