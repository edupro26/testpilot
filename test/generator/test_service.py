"""Tests for src.generator.service."""

import pytest
from src.exceptions import GeneratorError
from src.generator.service import Generator
from src.llm.provider.mock import MockProvider
from src.model.enums import ElementType, IdentifierType
from src.model.test_case import ExecutionStep, ExtractedData, Module, TestCase

_TEST_CASE = TestCase(
    name="Login User with Incorrect Credentials",
    modules=[
        Module(
            url="https://automationexercise.com",
            description="Home page",
            execution_steps=[
                ExecutionStep(step="Navigate to the home page"),
                ExecutionStep(
                    step="Click the 'Signup / Login' button",
                    extracted_data=[
                        ExtractedData(
                            type=ElementType.LINK,
                            request_description="The Signup / Login link",
                            identifier_type=IdentifierType.CSS,
                            identifier_tracking="a[href*='login']",
                        )
                    ],
                ),
            ],
        ),
        Module(
            url="https://automationexercise.com/login",
            description="Login page, reached via the previous module's click",
            execution_steps=[
                ExecutionStep(
                    step="Click the Login button",
                    extracted_data=[
                        ExtractedData(
                            type=ElementType.BUTTON,
                            request_description="The Login button",
                            identifier_type=IdentifierType.CSS,
                            identifier_tracking="[data-qa='login-button']",
                        )
                    ],
                )
            ],
        ),
    ],
)

_VALID_SCRIPT = (
    "from playwright.sync_api import Page, expect\n\n\n"
    "def test_login_user_with_incorrect_credentials(page: Page) -> None:\n"
    "    # MODULE 0\n"
    '    page.goto("https://automationexercise.com")\n'
    "    page.locator(\"css=a[href*='login']\").click()\n"
    "    # MODULE 1\n"
    "    page.locator(\"css=[data-qa='login-button']\").click()\n"
)


def test_run_returns_script_with_its_test_function() -> None:
    """A well-formed script response is returned with its test function."""
    generator = Generator(MockProvider(_VALID_SCRIPT))

    result = generator.run(_TEST_CASE)

    assert "def test_login_user_with_incorrect_credentials" in result


def test_run_produces_syntactically_valid_python() -> None:
    """The injected result still compiles as a Python module."""
    generator = Generator(MockProvider(_VALID_SCRIPT))

    result = generator.run(_TEST_CASE)

    compile(result, "<generated>", "exec")


def test_run_dismisses_overlays_once_per_module_after_its_page_loads() -> None:
    """Each module gets exactly one dismissal call, placed after its own goto."""
    generator = Generator(MockProvider(_VALID_SCRIPT))

    result = generator.run(_TEST_CASE)

    assert result.count("_dismiss_overlays(page)") == 2
    assert "def _dismiss_overlays(page: Page) -> None:" in result
    goto_index = result.index('page.goto("https://automationexercise.com")')
    first_dismissal = result.index("_dismiss_overlays(page)", goto_index)
    assert result[goto_index:first_dismissal].count("\n") == 1  # right after goto
    assert "# MODULE" not in result


def test_run_dismisses_overlays_after_goto_even_with_a_blank_line_between() -> None:
    """A blank line between the marker and its goto doesn't break the anchor.

    The prompt forbids this, but the LLM isn't trusted to always comply --
    dismissal must still land after navigation, not before it.
    """
    spaced_script = (
        "from playwright.sync_api import Page, expect\n\n\n"
        "def test_login_user_with_incorrect_credentials(page: Page) -> None:\n"
        "    # MODULE 0\n"
        "\n"
        '    page.goto("https://automationexercise.com")\n'
        "    page.locator(\"css=a[href*='login']\").click()\n"
        "    # MODULE 1\n"
        "    page.locator(\"css=[data-qa='login-button']\").click()\n"
    )
    generator = Generator(MockProvider(spaced_script))

    result = generator.run(_TEST_CASE)

    goto_index = result.index('page.goto("https://automationexercise.com")')
    first_dismissal = result.index("_dismiss_overlays(page)", goto_index)
    assert result[goto_index:first_dismissal].count("\n") == 1  # right after goto


def test_run_dismisses_overlays_for_a_module_reached_only_via_a_click() -> None:
    """A module with no page.goto() of its own still gets a dismissal call."""
    generator = Generator(MockProvider(_VALID_SCRIPT))

    result = generator.run(_TEST_CASE)

    login_click_index = result.index("css=a[href*='login']")
    login_button_index = result.index("css=[data-qa='login-button']")
    second_dismissal = result.index("_dismiss_overlays(page)", login_click_index)
    assert login_click_index < second_dismissal < login_button_index


def test_run_strips_markdown_code_fence() -> None:
    """A response wrapped in a ```python fence has the fence stripped."""
    fenced = f"```python\n{_VALID_SCRIPT}```"
    generator = Generator(MockProvider(fenced))

    result = generator.run(_TEST_CASE)

    assert not result.startswith("```")
    assert not result.endswith("```")


def test_run_raises_generator_error_for_empty_response() -> None:
    """An empty LLM response raises GeneratorError."""
    generator = Generator(MockProvider(""))

    with pytest.raises(GeneratorError, match="empty"):
        generator.run(_TEST_CASE)


def test_run_raises_generator_error_when_no_test_function_found() -> None:
    """A response with no 'def test_' function raises GeneratorError."""
    generator = Generator(MockProvider("print('not a test')"))

    with pytest.raises(GeneratorError, match="does not look like a test script"):
        generator.run(_TEST_CASE)


def test_run_raises_generator_error_when_a_module_marker_is_missing() -> None:
    """A script missing one module's marker raises GeneratorError, not a bad script."""
    missing_marker = (
        "from playwright.sync_api import Page, expect\n\n\n"
        "def test_login_user_with_incorrect_credentials(page: Page) -> None:\n"
        "    # MODULE 0\n"
        '    page.goto("https://automationexercise.com")\n'
        "    page.locator(\"css=[data-qa='login-button']\").click()\n"
    )
    generator = Generator(MockProvider(missing_marker))

    with pytest.raises(GeneratorError, match="MODULE"):
        generator.run(_TEST_CASE)


def test_run_raises_generator_error_when_markers_are_out_of_order() -> None:
    """Markers out of order (e.g. duplicated 0) raise GeneratorError."""
    duplicated_marker = (
        "from playwright.sync_api import Page, expect\n\n\n"
        "def test_login_user_with_incorrect_credentials(page: Page) -> None:\n"
        "    # MODULE 0\n"
        '    page.goto("https://automationexercise.com")\n'
        "    # MODULE 0\n"
        "    page.locator(\"css=[data-qa='login-button']\").click()\n"
    )
    generator = Generator(MockProvider(duplicated_marker))

    with pytest.raises(GeneratorError, match="MODULE"):
        generator.run(_TEST_CASE)


def test_run_includes_test_case_json_in_the_prompt() -> None:
    """The rendered prompt includes the test case's JSON."""
    captured_prompts = []

    def _capture(_system_prompt: str, user_prompt: str) -> str:
        captured_prompts.append(user_prompt)
        return _VALID_SCRIPT

    generator = Generator(MockProvider(_capture))

    generator.run(_TEST_CASE)

    assert _TEST_CASE.name in captured_prompts[0]
