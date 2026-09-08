"""Crawler service's own result contract, independent of Crawl4AI internals."""

from pydantic import BaseModel


class CrawlResult(BaseModel):
    """The outcome of crawling a single public page."""

    url: str
    success: bool
    html: str = ""
    error_message: str = ""
