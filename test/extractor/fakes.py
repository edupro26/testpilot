"""Offline test doubles for the Playwright MCP connection."""

from src.extractor.mcp.constants import ALLOWED_TOOLS
from src.extractor.mcp.server import McpResult, McpTool


def emitted(*lines: str) -> str:
    """Build a successful MCP result body reporting `lines` as the code it ran."""
    body = "\n".join(lines)
    return f"### Ran Playwright code\n```python\n{body}\n```\n### Page\n- Page URL: /"


class FakeMCP:
    """Stands in for `PlaywrightMCP`, replaying scripted tool results."""

    def __init__(self, results: dict[str, McpResult] | None = None) -> None:
        """Initialize with a per-tool-name result map.

        Args:
            results: Result returned for each tool name. A tool with no
                entry returns an empty successful result.
        """
        self._results = results or {}
        self.calls: list[tuple[str, dict]] = []

    def list_tools(self) -> list[McpTool]:
        """Return a stub definition for every allowlisted tool."""
        return [
            McpTool(name=name, description=f"{name} description", input_schema={})
            for name in ALLOWED_TOOLS
        ]

    def call_tool(self, name: str, arguments: dict) -> McpResult:
        """Record the call and return its scripted result."""
        self.calls.append((name, arguments))
        return self._results.get(
            name, McpResult(is_error=False, content="### Result\nDone")
        )
