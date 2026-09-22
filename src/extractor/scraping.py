"""Custom Crawl4AI scraping strategy: keep attributes, cap output size."""

from crawl4ai.content_scraping_strategy import LXMLWebScrapingStrategy
from lxml.html import HtmlElement, tostring

# Hard cap on the cleaned HTML this strategy produces, sized conservatively
# against the smallest supported provider's context window (~128K tokens
# for Azure/OpenAI) with headroom for the prompt, schema, and completion.
MAX_HTML_CHARS = 300_000


class AttributePreservingScraper(LXMLWebScrapingStrategy):
    """Scraping strategy that keeps every attribute and caps output size."""

    def __init__(self, keywords: frozenset[str] = frozenset()) -> None:
        """Initialize with `keywords` to protect when trimming is needed.

        Args:
            keywords: Relevance signal for last-resort trimming (empty by
                default, which falls back to plain end-of-document removal).
        """
        super().__init__()
        self._keywords = keywords

    def remove_unwanted_attributes_fast(
        self,
        root: HtmlElement,
        important_attrs: set[str] | None = None,  # noqa: ARG002
        keep_data_attributes: bool = False,  # noqa: ARG002
    ) -> None:
        """Remove the least keyword-relevant elements to fit the size cap."""
        _truncate_to_char_budget(root, MAX_HTML_CHARS, self._keywords)


def _truncate_to_char_budget(
    root: HtmlElement, max_chars: int, keywords: frozenset[str] = frozenset()
) -> None:
    """Remove the least keyword-relevant elements until `root` fits `max_chars`.

    Elements are removed in ascending order of relevance to `keywords`, most
    deeply nested first on ties. With no keywords every score is 0, so this
    reduces to plain removal from the end of the document.
    """
    if _serialized_length(root) <= max_chars:
        return
    elements = [element for element in root.iter() if isinstance(element.tag, str)]
    ordered = sorted(
        enumerate(elements), key=lambda pair: (_score(pair[1], keywords), -pair[0])
    )
    for _, element in ordered:
        if _serialized_length(root) <= max_chars:
            return
        parent = element.getparent()
        if parent is not None:
            parent.remove(element)


def _serialized_length(root: HtmlElement) -> int:
    """Return the length `root` will have once Crawl4AI serializes it.

    Uses `LXMLWebScrapingStrategy._scrap`'s own `tostring(...)` call and
    `tostring(..., pretty_print=True)` to match the actual output size, not
    the size of the raw HTML.
    """
    return len(
        tostring(
            root, encoding="unicode", pretty_print=True, method="html", with_tail=False
        ).strip()
    )


def _score(element: HtmlElement, keywords: frozenset[str]) -> int:
    """Return how many `keywords` appear in `element`'s subtree text/attributes."""
    if not keywords:
        return 0
    haystack = (
        element.text_content().lower() + " " + " ".join(element.attrib.values()).lower()
    )
    return sum(1 for word in keywords if word in haystack)
