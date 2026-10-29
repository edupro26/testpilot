"""Extractor service: drive each execution step live and collect its code."""

import logging

from src.extractor.agent import StepAgent
from src.extractor.mcp.server import PlaywrightMCP
from src.extractor.utils import describe_browser_context
from src.llm.protocol import LLMProvider
from src.model.test_case import Module, StepStatement

logger = logging.getLogger(__name__)


class Extractor:
    """Performs a module's steps in a live browser, collecting the code."""

    def __init__(
        self, llm: LLMProvider, mcp: PlaywrightMCP, *, max_turns: int = 25
    ) -> None:
        """Initialize with the collaborators the agent loop needs.

        Args:
            llm: Provides the tool-calling conversation.
            mcp: The live Playwright MCP connection, shared across the run.
            max_turns: Cap on assistant turns per step.
        """
        self._agent = StepAgent(llm, mcp, max_turns=max_turns)

    def run_step(
        self,
        module: Module,
        index: int,
        *,
        history: list[str],
        feedback: str | None = None,
        reset_to: str | None = None,
    ) -> list[StepStatement]:
        """Perform one execution step and return its collected statements.

        Args:
            module: The module the step belongs to.
            index: The step's position within `module.execution_steps`.
            history: Statements already accepted for earlier steps, used to
                tell the agent what the browser is already showing.
            feedback: Why the previous attempt at this step was rejected.
            reset_to: The URL a freshly reset MCP browser was sent to, when
                retrying. Earlier steps' state is then gone from it.

        Returns:
            The step's statements, in execution order.

        Raises:
            ExtractorError: If the step cannot be completed or the model
                reports code MCP never ran.
        """
        step = module.execution_steps[index]
        logger.info(
            "Extracting step %d/%d of %s",
            index + 1,
            len(module.execution_steps),
            module.url,
        )
        return self._agent.run(
            step.step,
            context=describe_browser_context(module, history, reset_to),
            feedback=feedback,
        )
