"""Tests for src.validator.browser, against a real Chromium on `data:` URLs."""

import pytest
from src.model.test_case import StepStatement
from src.validator.browser import BrowserError, ValidationBrowser

_PAGE = (
    "data:text/html,"
    "<button id='go'>Login</button>"
    "<p>Your email or password is incorrect!</p>"
    "<a href='#'>Repeated</a><a href='#'>Repeated</a>"
)


@pytest.fixture
def browser() -> ValidationBrowser:
    """A live validation browser on the test page, closed after the test."""
    browser = ValidationBrowser()
    browser.run([StepStatement(code=f'page.goto("{_PAGE}")')])
    yield browser
    browser.close()


def test_replays_code_verbatim_on_cumulative_state(browser: ValidationBrowser) -> None:
    """Each run builds on the state earlier runs left; reset discards it all."""
    browser.run(
        [
            StepStatement(
                code='expect(page.get_by_role("button", name="Login")).to_be_visible()'
            ),
            StepStatement(code='page.get_by_role("button", name="Login").click()'),
        ]
    )
    browser.run(
        [StepStatement(code='expect(page.get_by_text("incorrect!")).to_be_visible()')]
    )

    browser.reset()

    assert browser.page.url == "about:blank"


@pytest.mark.parametrize(
    "code",
    [
        pytest.param(
            'page.get_by_role("button", name="Nope").click(timeout=1500)',
            id="matches-nothing",
        ),
        pytest.param(
            'page.get_by_role("link", name="Repeated").click(timeout=1500)',
            id="matches-several",
        ),
        pytest.param(
            'expect(page.get_by_text("Welcome back")).to_be_visible(timeout=1500)',
            id="false-assertion",
        ),
    ],
)
def test_code_that_does_not_hold_on_the_page_fails(
    browser: ValidationBrowser, code: str
) -> None:
    """Code that runs is not enough: the locator must be unique and true."""
    with pytest.raises(BrowserError) as excinfo:
        browser.run([StepStatement(code=code)])

    assert excinfo.value.code == code
    assert excinfo.value.reason
