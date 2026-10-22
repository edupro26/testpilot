"""Playwright MCP client: a blocking facade over an async session.

Connects to an already-running server over HTTP. The async session lives on a
background thread so the caller's thread stays loop-free for sync Playwright.
"""

import asyncio
import logging
import threading
from concurrent.futures import Future

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import BaseModel, Field

from src.exceptions import McpError
from src.extractor.mcp.constants import (
    ALLOWED_TOOLS,
    CALL_TIMEOUT_SECONDS,
    CODE_BLOCK,
    CONNECT_TIMEOUT_SECONDS,
    SHUTDOWN_TIMEOUT_SECONDS,
)

logger = logging.getLogger(__name__)


class McpTool(BaseModel):
    """A tool offered by the MCP server, in the provider-neutral shape."""

    name: str
    description: str = ""
    input_schema: dict = Field(default_factory=dict)


class McpResult(BaseModel):
    """The outcome of one MCP tool call."""

    is_error: bool
    content: str

    @property
    def code(self) -> list[str]:
        """The Playwright statements this call ran; empty for a failed call."""
        match = CODE_BLOCK.search(self.content)
        return match.group(1).splitlines() if match else []


class PlaywrightMCP:
    """Blocking client for a running Playwright MCP server.

    The session's event loop runs on a background thread; every public method
    blocks the caller, whose thread stays free for sync Playwright.
    """

    def __init__(self, url: str) -> None:
        """Connect to the MCP server at `url`.

        Args:
            url: The server's streamable-HTTP endpoint, e.g.
                `http://localhost:8931/mcp`.

        Raises:
            McpError: If the server cannot be reached or does not offer
                every tool in `ALLOWED_TOOLS`.
        """
        self._url = url
        self._session: ClientSession | None = None
        self._loop = asyncio.new_event_loop()
        self._ready: Future[bool] = Future()
        self._stop: asyncio.Event | None = None
        self._thread = threading.Thread(
            target=self._run_loop, name="playwright-mcp", daemon=True
        )

        logger.info("Connecting to Playwright MCP at %s", url)
        self._thread.start()
        try:
            self._ready.result(timeout=CONNECT_TIMEOUT_SECONDS)
        except Exception as exc:
            raise McpError(
                f"Could not connect to the Playwright MCP server at {url}. "
                f"Start it with: npx @playwright/mcp@latest "
                f"--config ./mcp/config.json ({exc})"
            ) from exc

        self.tools = self._resolve_tools()
        logger.info(
            "Connected to Playwright MCP (%d tool(s) available)", len(self.tools)
        )

    def _run_loop(self) -> None:
        """Entry point for the background thread."""
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
        finally:
            self._loop.close()

    async def _serve(self) -> None:
        """Hold the MCP session open until `close()` is called."""
        self._stop = asyncio.Event()
        try:
            async with (
                streamable_http_client(self._url) as (read, write),
                ClientSession(read, write) as session,
            ):
                await session.initialize()
                self._session = session
                self._ready.set_result(True)
                await self._stop.wait()
        except Exception as exc:
            if not self._ready.done():
                self._ready.set_exception(exc)
            else:
                logger.error("Playwright MCP session ended unexpectedly: %s", exc)

    def _submit(self, coro: object) -> object:
        """Run `coro` on the session's loop and block until it finishes."""
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=CALL_TIMEOUT_SECONDS)

    def _resolve_tools(self) -> list[McpTool]:
        """Return the allowlisted tools, failing loudly if any is missing.

        The server tracks `@latest`, so this turns an upstream rename into a
        named error rather than a quietly degraded agent.

        Raises:
            McpError: If the server does not offer every allowlisted tool.
        """
        offered = {tool.name: tool for tool in self._submit(self._list_tools())}
        missing = [name for name in ALLOWED_TOOLS if name not in offered]
        if missing:
            raise McpError(
                f"Playwright MCP is missing expected tool(s): {', '.join(missing)}. "
                f"Was it started with --config ./mcp/config.json, which "
                f"enables the testing capability? "
                f"It offered: {', '.join(sorted(offered))}"
            )
        return [
            McpTool(
                name=name,
                description=offered[name].description or "",
                input_schema=offered[name].input_schema or {},
            )
            for name in ALLOWED_TOOLS
        ]

    async def _list_tools(self) -> list:
        """List every tool the server offers."""
        if self._session is None:
            raise McpError("MCP session is not connected")
        return (await self._session.list_tools()).tools

    async def _call_tool(self, name: str, arguments: dict) -> McpResult:
        """Invoke one tool and flatten its result to text."""
        if self._session is None:
            raise McpError("MCP session is not connected")
        result = await self._session.call_tool(name, arguments)
        content = "\n".join(
            block.text for block in result.content if block.type == "text"
        )
        return McpResult(is_error=bool(result.is_error), content=content)

    def list_tools(self) -> list[McpTool]:
        """Return the allowlisted tools, resolved at connection time."""
        return self.tools

    def call_tool(self, name: str, arguments: dict) -> McpResult:
        """Invoke an allowlisted MCP tool and block for its result.

        Args:
            name: The tool to call.
            arguments: The call's arguments.

        Returns:
            The call's outcome, including any Playwright code it ran.

        Raises:
            McpError: If `name` is not allowlisted, or the call fails at
                the transport level.
        """
        if name not in ALLOWED_TOOLS:
            raise McpError(f"Tool {name!r} is not allowlisted")
        logger.debug("MCP call %s %s", name, arguments)
        try:
            result = self._submit(self._call_tool(name, arguments))
        except McpError:
            raise
        except Exception as exc:
            raise McpError(f"MCP call {name!r} failed: {exc}") from exc
        logger.debug(
            "MCP result (is_error=%s, %d chars)",
            result.is_error,
            len(result.content),
        )
        return result

    def reset(self) -> None:
        """Reconnect, discarding all browser state.

        The server is `isolated`, so a new session gets a fresh profile that
        has forgotten the failed attempt, cookies included.

        Raises:
            McpError: If the server cannot be reached again.
        """
        logger.info("Resetting the Playwright MCP session")
        self.close()
        self._session = None
        self._ready = Future()
        self._stop = None
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop, name="playwright-mcp", daemon=True
        )
        self._thread.start()
        try:
            self._ready.result(timeout=CONNECT_TIMEOUT_SECONDS)
        except Exception as exc:
            raise McpError(f"Could not reconnect to Playwright MCP: {exc}") from exc

    def close(self) -> None:
        """Shut the session down and join its thread."""
        if self._stop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)
        self._thread.join(timeout=SHUTDOWN_TIMEOUT_SECONDS)
        logger.info("Disconnected from Playwright MCP")

    def __enter__(self) -> "PlaywrightMCP":
        """Enter a context managing this connection."""
        return self

    def __exit__(self, *exc_info: object) -> None:
        """Close the connection on context exit."""
        self.close()
