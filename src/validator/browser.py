"""The validation browser: runs validated statements, and nothing else.

The pipeline's ground truth. Unlike the MCP browser, it carries no failed
attempts or implicit waits, and runs exactly what the Generator will ship.
State is cumulative across steps, as in the finished script.
"""

import logging

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page, Playwright, expect, sync_playwright

from src.model.test_case import StepStatement

logger = logging.getLogger(__name__)


class BrowserError(Exception):
    """Raised when a statement fails to execute against the live page."""

    def __init__(self, code: str, reason: str, ran: list[str] | None = None) -> None:
        """Initialize with the offending statement and Playwright's reason.

        Args:
            code: The statement that failed.
            reason: Playwright's error message, trimmed.
            ran: Statements that ran before it in the same call.
        """
        self.code = code
        self.reason = reason
        self.ran = ran or []
        super().__init__(f"{code}\n{reason}")


class ValidationBrowser:
    """A live Python Playwright page replaying validated statements."""

    def __init__(self, *, headless: bool = True, locale: str = "en-US") -> None:
        """Launch the validation browser.

        Args:
            headless: Whether to run the browser headless.
            locale: The context locale (`Accept-Language`); must match the
                MCP browser and the generated script.
        """
        self._playwright: Playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(headless=headless)
        self._locale = locale
        self._context = self._browser.new_context(locale=locale)
        self._page: Page = self._context.new_page()
        logger.debug("Validation browser launched (locale=%s)", locale)

    @property
    def page(self) -> Page:
        """The page statements are replayed against."""
        return self._page

    def run(self, statements: list[StepStatement]) -> None:
        """Execute `statements` against the live page, in order.

        Args:
            statements: The step's statements, as collected.

        Raises:
            BrowserError: If a statement raises. The exception names the
                statement and Playwright's reason, which is fed back to the
                agent as retry feedback.
        """
        ran: list[str] = []
        for statement in statements:
            try:
                exec(statement.code, self._scope())
            except (PlaywrightError, AssertionError) as exc:
                raise BrowserError(statement.code, _trim(str(exc)), ran) from exc
            ran.append(statement.code)
            logger.debug("Replayed: %s", statement.code)

    def reset(self) -> None:
        """Discard all state, cookies included, to re-run a prefix after a failure."""
        self._context.close()
        self._context = self._browser.new_context(locale=self._locale)
        self._page = self._context.new_page()
        logger.debug("Validation browser reset")

    def close(self) -> None:
        """Shut the browser and its driver down."""
        self._browser.close()
        self._playwright.stop()
        logger.debug("Validation browser closed")

    def _scope(self) -> dict:
        """The minimal names a statement may reference under `exec`."""
        return {"page": self._page, "expect": expect}

    def __enter__(self) -> "ValidationBrowser":
        """Enter a context managing this browser."""
        return self

    def __exit__(self, *exc_info: object) -> None:
        """Close the browser on context exit."""
        self.close()


def _trim(message: str, limit: int = 1200) -> str:
    """Trim a Playwright error, which can carry a very long call log."""
    message = message.strip()
    return message if len(message) <= limit else f"{message[:limit]}\n... (truncated)"
