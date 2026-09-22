"""Tests for src.extractor.scraping."""

import pytest
from lxml import html as lhtml
from src.extractor.scraping import (
    AttributePreservingScraper,
    _serialized_length,
    _truncate_to_char_budget,
)


def test_scraper_keeps_structurally_identical_elements_under_budget() -> None:
    """Elements sharing a (tag, class, text) signature are never collapsed.

    Regression test: a carousel with several slides repeating the same
    heading (e.g. automationexercise.com's homepage) is a real page where
    this happens, and collapsing the repeats would make a selector that
    truly resolves to N elements on the live page look artificially unique
    to the Validator's uniqueness check.
    """
    tree = lhtml.fromstring(
        "<div>"
        "<h1 class='slide'>Welcome</h1>"
        "<h1 class='slide'>Welcome</h1>"
        "<h1 class='slide'>Welcome</h1>"
        "</div>"
    )

    AttributePreservingScraper().remove_unwanted_attributes_fast(tree)

    assert len(tree.xpath("//h1")) == 3


@pytest.mark.parametrize(
    ("budget_delta", "expected_texts"),
    [(1_000, ["first", "second", "third"]), (-1, ["first", "second"])],
    ids=["under_budget_is_a_noop", "over_budget_drops_trailing_elements"],
)
def test_truncate_to_char_budget(budget_delta: int, expected_texts: list[str]) -> None:
    """Truncation is a no-op under budget; drops trailing elements once over it."""
    tree = lhtml.fromstring("<div><p>first</p><p>second</p><p>third</p></div>")
    budget = _serialized_length(tree) + budget_delta

    _truncate_to_char_budget(tree, max_chars=budget)

    assert _serialized_length(tree) <= budget
    assert [p.text for p in tree.xpath("//p")] == expected_texts


def test_truncate_skips_comment_nodes_without_crashing() -> None:
    """HTML comments are ignored by scoring/removal, not a crash.

    Regression test: `.text_content()` raises on a comment node (it has no
    string `.tag`), and `root.iter()` yields comments alongside real
    elements -- this only ever surfaced once dedup was removed and pages
    large enough to need real trimming stopped being pre-shrunk first.
    """
    tree = lhtml.fromstring(
        "<div><!-- a comment -->" + "<p>filler text here</p>" * 20 + "</div>"
    )
    budget = _serialized_length(tree) // 2

    _truncate_to_char_budget(tree, max_chars=budget)

    assert _serialized_length(tree) <= budget


def test_truncate_protects_keyword_relevant_elements() -> None:
    """A relevant element (and its ancestor chain) survives over irrelevant filler.

    The relevant <button> sits inside a wrapper <div> alongside a lot of
    irrelevant filler content. Scoring by subtree text (not just an
    element's own text) means the wrapper inherits the button's relevance,
    so it survives too -- removing it would remove the button.
    """
    filler = "".join(
        f"<p>irrelevant filler paragraph number {i}</p>" for i in range(50)
    )
    tree = lhtml.fromstring(
        f"<div class='wrapper'>{filler}<button id='login'>Login</button></div>"
    )
    budget = len(filler) // 2  # forces removal of most filler, well under full size

    _truncate_to_char_budget(tree, max_chars=budget, keywords=frozenset({"login"}))

    assert tree.xpath("//button[@id='login']")
    assert len(tree.xpath("//p")) < 50
