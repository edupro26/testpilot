"""Tests for src.validator.browser, against a real Chromium on `data:` URLs."""

import pytest
from src.model.test_case import StepStatement
from src.validator.browser import BrowserError, ValidationBrowser

_REPEATED_CLICK = 'page.get_by_role("link", name="Repeated").click(timeout=1500)'

_PAGE = (
    "data:text/html,"
    "<button id='go'>Login</button>"
    "<p>Your email or password is incorrect!</p>"
    "<a href='#'>Repeated</a><a href='#'>Repeated</a>"
)


@pytest.fixture
def browser() -> ValidationBrowser:
    """A live validation browser, closed after the test."""
    browser = ValidationBrowser()
    yield browser
    browser.close()


def _goto() -> StepStatement:
    return StepStatement(code=f'page.goto("{_PAGE}")')


def test_replays_an_action_and_an_assertion(browser: ValidationBrowser) -> None:
    """The happy path: collected code executes verbatim."""
    browser.run(
        [
            _goto(),
            StepStatement(
                code='expect(page.get_by_role("button", name="Login")).to_be_visible()'
            ),
            StepStatement(code='page.get_by_role("button", name="Login").click()'),
        ]
    )

    assert "Login" in browser.page.content()


def test_a_locator_matching_nothing_fails(browser: ValidationBrowser) -> None:
    """Replaces the old count_dom_matches == 0 check."""
    with pytest.raises(BrowserError) as excinfo:
        browser.run(
            [
                _goto(),
                StepStatement(
                    code='page.get_by_role("button", name="Nope").click(timeout=1500)'
                ),
            ]
        )

    assert "Nope" in excinfo.value.code


def test_a_locator_matching_several_elements_fails(browser: ValidationBrowser) -> None:
    """Replaces the old count_dom_matches > 1 check."""
    with pytest.raises(BrowserError) as excinfo:
        browser.run(
            [
                _goto(),
                StepStatement(code=_REPEATED_CLICK),
            ]
        )

    assert "Repeated" in excinfo.value.code
    assert excinfo.value.reason


def test_a_false_assertion_fails(browser: ValidationBrowser) -> None:
    """Code that runs is not enough -- a wrong assertion must be caught."""
    with pytest.raises(BrowserError):
        browser.run(
            [
                _goto(),
                StepStatement(
                    code='expect(page.get_by_text("Welcome back"))'
                    ".to_be_visible(timeout=1500)"
                ),
            ]
        )


def test_state_is_cumulative_across_calls(browser: ValidationBrowser) -> None:
    """Each step builds on the real state the finished script will produce."""
    browser.run([_goto()])
    browser.run(
        [StepStatement(code='expect(page.get_by_text("incorrect!")).to_be_visible()')]
    )


def test_reset_discards_page_state(browser: ValidationBrowser) -> None:
    """Used to re-run a validated prefix after a failure."""
    browser.run([_goto()])
    browser.reset()

    assert browser.page.url == "about:blank"
