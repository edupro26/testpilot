"""Tests for src.validator.uniqueness."""

import pytest
from src.model.enums import ElementType, IdentifierType
from src.validator.uniqueness import count_dom_matches, element_type_is_plausible

_LOGIN_BUTTON_HTML = "<button id='login-button' data-qa='login'>Login</button>"

_TRIPLE_HEADING_HTML = "<h2>Welcome</h2><h2>Welcome</h2><h2>Welcome</h2>"


@pytest.mark.parametrize(
    ("html", "identifier_type", "tracking", "expected_count"),
    [
        (_LOGIN_BUTTON_HTML, IdentifierType.ID, "login-button", 1),
        (_LOGIN_BUTTON_HTML, IdentifierType.CSS, "[data-qa='login']", 1),
        (_LOGIN_BUTTON_HTML, IdentifierType.XPATH, "//button", 1),
        (_LOGIN_BUTTON_HTML, IdentifierType.TEXT, "Login", 1),
        (_TRIPLE_HEADING_HTML, IdentifierType.CSS, "h2", 3),
        (_TRIPLE_HEADING_HTML, IdentifierType.XPATH, "//h2", 3),
        (_TRIPLE_HEADING_HTML, IdentifierType.TEXT, "Welcome", 3),
    ],
    ids=[
        "id_unique",
        "css_unique",
        "xpath_unique",
        "text_unique",
        "css_duplicates",
        "xpath_duplicates",
        "text_duplicates",
    ],
)
def test_count_dom_matches_reports_the_real_element_count(
    html: str, identifier_type: IdentifierType, tracking: str, expected_count: int
) -> None:
    """Every identifier type reports its true match count, unique or duplicated.

    A count > 1 is the strict-mode-violation case a real Playwright locator
    would hit too.
    """
    assert count_dom_matches(html, identifier_type, tracking) == expected_count


def test_text_match_is_leaf_most_not_double_counted_through_a_wrapper() -> None:
    """A wrapper element containing a matching child isn't double-counted."""
    html = "<div class='hero'><h1>Welcome</h1></div>"

    assert count_dom_matches(html, IdentifierType.TEXT, "Welcome") == 1


def test_text_match_is_case_insensitive_and_whitespace_normalized() -> None:
    """Text matching normalizes whitespace and casefolds, like Playwright."""
    html = "<h2>Welcome\n   Home</h2>"

    assert count_dom_matches(html, IdentifierType.TEXT, "welcome home") == 1


@pytest.mark.parametrize(
    ("identifier_type", "tracking"),
    [(IdentifierType.CSS, "###not-css"), (IdentifierType.XPATH, "///not[[xpath")],
    ids=["css", "xpath"],
)
def test_malformed_selector_counts_as_zero_instead_of_raising(
    identifier_type: IdentifierType, tracking: str
) -> None:
    """An unparsable CSS/XPath selector reports 0 rather than raising."""
    assert count_dom_matches(_LOGIN_BUTTON_HTML, identifier_type, tracking) == 0


def test_empty_html_counts_as_zero_for_every_identifier_type() -> None:
    """Empty HTML reports 0 matches for every identifier type, never raises.

    A selector as broad as "div" would also match the synthetic wrapper
    `_parse` introduces (a documented, accepted limitation), so these use
    more specific selectors that can't collide with it.
    """
    assert count_dom_matches("", IdentifierType.ID, "anything") == 0
    assert count_dom_matches("   ", IdentifierType.CSS, "button") == 0
    assert count_dom_matches("", IdentifierType.XPATH, "//button") == 0
    assert count_dom_matches("", IdentifierType.TEXT, "anything") == 0


@pytest.mark.parametrize(
    ("html", "xpath_expr"),
    [("<h1>Hi</h1>", "string(//h1)"), ("<h1 id='heading'>Hi</h1>", "//h1/@id")],
    ids=["scalar_result", "attribute_result"],
)
def test_xpath_non_element_result_counts_as_zero(html: str, xpath_expr: str) -> None:
    """A scalar or attribute-node XPath result reports 0, not a miscounted length.

    `tree.xpath("string(//h1)")` returns a `str`, whose `len()` would
    otherwise be mistaken for an element count.
    """
    assert count_dom_matches(html, IdentifierType.XPATH, xpath_expr) == 0


@pytest.mark.parametrize(
    ("html", "tracking"),
    [
        ('<div id="it\'s-me">hi</div>', "it's-me"),
        ('<div id="say &quot;hi&quot;">hi</div>', 'say "hi"'),
    ],
    ids=["single_quote", "double_quote"],
)
def test_id_value_containing_a_quote_resolves_correctly(
    html: str, tracking: str
) -> None:
    """An id value containing a quote is handled by the XPath literal helper."""
    assert count_dom_matches(html, IdentifierType.ID, tracking) == 1


def test_id_value_starting_with_a_digit_resolves_correctly() -> None:
    """An id starting with a digit (invalid as a bare CSS identifier) resolves."""
    html = "<div id='123-login'>hi</div>"

    assert count_dom_matches(html, IdentifierType.ID, "123-login") == 1


def test_multi_root_fragment_is_parsed_without_error() -> None:
    """A fragment with multiple top-level siblings (no single root) parses fine.

    Crawl4AI's cleaned HTML is a body-content fragment, not a full document,
    so it commonly has more than one top-level element.
    """
    html = "<h1>Title</h1><button id='go'>Go</button>"

    assert count_dom_matches(html, IdentifierType.XPATH, "//h1") == 1
    assert count_dom_matches(html, IdentifierType.ID, "go") == 1


@pytest.mark.parametrize(
    ("html", "tracking", "element_type", "expected"),
    [
        (_LOGIN_BUTTON_HTML, "login-button", ElementType.BUTTON, True),
        ("<input id='go' type='submit' value='Go'>", "go", ElementType.BUTTON, True),
        ("<div id='go' role='button'>Go</div>", "go", ElementType.BUTTON, True),
        ("<div id='go'>Go</div>", "go", ElementType.BUTTON, False),
        ("<a id='home' href='/'>Home</a>", "home", ElementType.LINK, True),
        (_LOGIN_BUTTON_HTML, "login-button", ElementType.LINK, False),
        ("<input id='email' type='text'>", "email", ElementType.INPUT, True),
        ("<input id='agree' type='checkbox'>", "agree", ElementType.INPUT, False),
        ("<input id='agree' type='checkbox'>", "agree", ElementType.CHECKBOX, True),
        (
            "<select id='country'><option>PT</option></select>",
            "country",
            ElementType.DROPDOWN,
            True,
        ),
        (_LOGIN_BUTTON_HTML, "login-button", ElementType.DROPDOWN, False),
    ],
    ids=[
        "button_matching_tag",
        "button_via_input_type_submit",
        "button_via_explicit_role",
        "button_implausible_on_a_div",
        "link_matching_tag",
        "link_implausible_on_a_button",
        "input_on_a_text_field",
        "input_implausible_on_a_checkbox",
        "checkbox",
        "dropdown_on_a_select",
        "dropdown_implausible_on_a_button",
    ],
)
def test_element_type_is_plausible(
    html: str, tracking: str, element_type: ElementType, expected: bool
) -> None:
    """Each element type's tag/role/type= check passes or fails as expected."""
    assert (
        element_type_is_plausible(html, IdentifierType.ID, tracking, element_type)
        is expected
    )


@pytest.mark.parametrize(
    ("html", "identifier_type", "tracking", "element_type"),
    [
        (_TRIPLE_HEADING_HTML, IdentifierType.CSS, "h2", ElementType.BUTTON),
        (_LOGIN_BUTTON_HTML, IdentifierType.ID, "does-not-exist", ElementType.BUTTON),
        (_LOGIN_BUTTON_HTML, IdentifierType.TEXT, "Login", ElementType.LINK),
        (
            "<div id='message'>Your email or password is incorrect!</div>",
            IdentifierType.ID,
            "message",
            ElementType.TEXT,
        ),
        (
            "<div id='message'>Your email or password is incorrect!</div>",
            IdentifierType.ID,
            "message",
            ElementType.OTHER,
        ),
    ],
    ids=[
        "non_unique_multiple_matches",
        "non_unique_zero_matches",
        "text_identifier_type",
        "text_element_type",
        "other_element_type",
    ],
)
def test_plausibility_defers_to_true_when_it_cannot_judge(
    html: str, identifier_type: IdentifierType, tracking: str, element_type: ElementType
) -> None:
    """Non-unique matches, text= identifiers, and TEXT/OTHER types all defer to True.

    Deferring on a non-unique match is deliberate: that's the uniqueness
    veto's job, not plausibility's.
    """
    assert element_type_is_plausible(html, identifier_type, tracking, element_type)
