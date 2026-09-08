"""Shared enums for the Level 2 JSON contract."""

from enum import StrEnum


class ElementType(StrEnum):
    """The kind of UI element an extracted identifier locates."""

    BUTTON = "button"
    LINK = "link"
    INPUT = "input"
    CHECKBOX = "checkbox"
    DROPDOWN = "dropdown"
    TEXT = "text"
    OTHER = "other"


class IdentifierType(StrEnum):
    """The locator strategy used to find an element.

    Mirrors Playwright's selector-engine prefixes (`css=`, `xpath=`,
    `text=`), plus a plain `id` shorthand, so the Generator (Level 3) can
    turn `identifier_type` and `identifier_tracking` into a Playwright
    locator without further translation.
    """

    ID = "id"
    CSS = "css"
    XPATH = "xpath"
    TEXT = "text"
