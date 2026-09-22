"""Deterministic, offline DOM checks for an extracted identifier.

Approximates, without a live browser, whether a Playwright locator would
resolve to exactly one element of a plausible tag/role for its claimed
`ElementType` -- static checks against the Crawler's cleaned HTML, not a
runtime guarantee (see `Validator`).
"""

import logging
from collections.abc import Callable

from cssselect import SelectorError
from lxml import etree
from lxml import html as lhtml
from lxml.html import HtmlElement

from src.model.enums import ElementType, IdentifierType

logger = logging.getLogger(__name__)


def count_dom_matches(
    html: str, identifier_type: IdentifierType, identifier_tracking: str
) -> int:
    """Count elements in `html` that an identifier would resolve to.

    Never raises: a malformed selector or unparseable HTML counts as 0
    matches, so a bad identifier fails validation instead of crashing.

    Args:
        html: The page HTML to check against.
        identifier_type: The locator strategy the identifier uses.
        identifier_tracking: The identifier's raw tracking value.

    Returns:
        The match count. Exactly 1 means unique; 0 or >1 means the real
        Playwright locator would fail (not found, or strict-mode violation).
    """
    return len(_resolve_matches(html, identifier_type, identifier_tracking))


def element_type_is_plausible(
    html: str,
    identifier_type: IdentifierType,
    identifier_tracking: str,
    element_type: ElementType,
) -> bool:
    """Whether the identifier's uniquely-matched element fits `element_type`.

    Checks tag semantics, ARIA roles, and `type=` attributes only -- never
    class/id patterns, which is the fuzzy judgment left to the Validator's
    LLM call. Defers (returns True) when the identifier isn't unique, uses
    `identifier_type=TEXT` (resolves to a leaf node with no meaningful tag),
    or `element_type` is TEXT/OTHER (no tag constraint applies).

    Args:
        html: The page HTML to check against.
        identifier_type: The locator strategy the identifier uses.
        identifier_tracking: The identifier's raw tracking value.
        element_type: The kind of element the identifier is claimed to be.

    Returns:
        False only when the identifier resolves to exactly one element
        whose tag/role contradicts `element_type`.
    """
    if identifier_type is IdentifierType.TEXT:
        return True

    check = _ELEMENT_TYPE_CHECKS.get(element_type)
    if check is None:
        return True

    matches = _resolve_matches(html, identifier_type, identifier_tracking)
    if len(matches) != 1:
        return True
    return check(matches[0])


def _resolve_matches(
    html: str, identifier_type: IdentifierType, identifier_tracking: str
) -> list[HtmlElement]:
    """Return every element in `html` that the identifier would match.

    Never raises -- a malformed selector or unparseable HTML resolves to
    no matches.
    """
    tree = _parse(html)
    if tree is None:
        return []

    try:
        if identifier_type is IdentifierType.ID:
            return _match_id(tree, identifier_tracking)
        if identifier_type is IdentifierType.CSS:
            return _match_css(tree, identifier_tracking)
        if identifier_type is IdentifierType.XPATH:
            return _match_xpath(tree, identifier_tracking)
    except (etree.LxmlError, SelectorError) as exc:
        logger.debug(
            "Could not evaluate %s selector %r: %s",
            identifier_type,
            identifier_tracking,
            exc,
        )
        return []

    return _match_text(tree, identifier_tracking)


def _parse(html: str) -> HtmlElement | None:
    """Parse `html` into a single-root tree, or None if it can't be parsed.

    Wrapped in a fixed container since Crawl4AI's cleaned HTML is a
    body-content fragment with no guaranteed single root.
    """
    try:
        return lhtml.fromstring(f"<div>{html}</div>")
    except Exception as exc:
        logger.debug("Could not parse HTML for uniqueness check: %s", exc)
        return None


def _match_id(tree: HtmlElement, value: str) -> list[HtmlElement]:
    """Return elements whose `id` attribute equals `value` exactly.

    Uses an XPath attribute comparison, not a CSS `#value` selector: not
    every valid attribute value is a valid CSS identifier without escaping
    (leading digits, `:`, `.`, whitespace...).
    """
    return _only_elements(tree.xpath(f"//*[@id={_xpath_literal(value)}]"))


def _match_css(tree: HtmlElement, value: str) -> list[HtmlElement]:
    """Return elements matching the CSS selector `value`."""
    return _only_elements(tree.cssselect(value))


def _match_xpath(tree: HtmlElement, value: str) -> list[HtmlElement]:
    """Return element results of the XPath expression `value`.

    An XPath result isn't always a list of elements (`count()`/`string()`
    return scalars, `//h1/@id` returns attributes) -- only real elements
    are returned.
    """
    result = tree.xpath(value)
    if not isinstance(result, list):
        return []
    return _only_elements(result)


def _only_elements(matches: object) -> list[HtmlElement]:
    """Return only the actual element nodes among `matches`."""
    if not isinstance(matches, list):
        return []
    return [node for node in matches if isinstance(node, HtmlElement)]


def _match_text(tree: HtmlElement, value: str) -> list[HtmlElement]:
    """Approximate Playwright's text engine: normalized substring, leaf-most.

    Every element whose (normalized, casefolded) text contains the needle is
    a candidate; any candidate that merely wraps another candidate is
    dropped, since Playwright resolves to the more specific descendant.
    """
    needle = _normalize(value)
    if not needle:
        return []

    candidates = [
        element
        for element in tree.iter()
        if isinstance(element, HtmlElement)
        and needle in _normalize(element.text_content())
    ]
    return [
        element
        for element in candidates
        if not any(
            other is not element and other in element.iterdescendants()
            for other in candidates
        )
    ]


def _normalize(text: str) -> str:
    """Collapse whitespace and casefold `text` for substring comparison."""
    return " ".join(text.split()).casefold()


def _xpath_literal(value: str) -> str:
    """Render `value` as an XPath string literal, escaping quotes as needed."""
    if '"' not in value:
        return f'"{value}"'
    if "'" not in value:
        return f"'{value}'"
    parts = value.split('"')
    return "concat(" + ", '\"', ".join(f'"{part}"' for part in parts) + ")"


def _is_button(element: HtmlElement) -> bool:
    """Whether `element` is a plausible button, input, or role="button"."""
    return (
        element.tag == "button"
        or (
            element.tag == "input"
            and element.get("type", "").lower() in {"button", "submit", "reset"}
        )
        or element.get("role", "").lower() == "button"
    )


def _is_link(element: HtmlElement) -> bool:
    """Whether `element` is a plausible link: `<a>` or `role="link"`."""
    return element.tag == "a" or element.get("role", "").lower() == "link"


def _is_input(element: HtmlElement) -> bool:
    """Whether `element` is a plausible text-entry field."""
    return (
        element.tag == "textarea"
        or (
            element.tag == "input"
            and element.get("type", "").lower()
            not in {"checkbox", "radio", "button", "submit", "reset"}
        )
        or element.get("role", "").lower() in {"textbox", "searchbox", "combobox"}
        or element.get("contenteditable", "").lower() == "true"
    )


def _is_checkbox(element: HtmlElement) -> bool:
    """Whether `element` is a plausible checkbox/radio/switch control."""
    return (
        element.tag == "input"
        and element.get("type", "").lower() in {"checkbox", "radio"}
    ) or element.get("role", "").lower() in {"checkbox", "switch"}


def _is_dropdown(element: HtmlElement) -> bool:
    """Whether `element` is a plausible dropdown: `<select>` or ARIA equivalent."""
    return element.tag == "select" or element.get("role", "").lower() in {
        "listbox",
        "combobox",
    }


_ELEMENT_TYPE_CHECKS: dict[ElementType, Callable[[HtmlElement], bool]] = {
    ElementType.BUTTON: _is_button,
    ElementType.LINK: _is_link,
    ElementType.INPUT: _is_input,
    ElementType.CHECKBOX: _is_checkbox,
    ElementType.DROPDOWN: _is_dropdown,
    # TEXT and OTHER intentionally absent: no tag constraint is meaningful.
}
