"""Loading and rendering of prompt templates."""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


def load_prompt(name: str) -> str:
    """Read the raw contents of a prompt template.

    Args:
        name: Template name without extension, e.g. "structurer".

    Returns:
        The raw template text.

    Raises:
        FileNotFoundError: If no template named `name` exists.
    """
    text = (_PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")
    logger.debug("Loaded prompt template %r (%d chars)", name, len(text))
    return text


def render_prompt(name: str, **kwargs: str) -> str:
    """Load a prompt template and fill in its placeholders.

    Args:
        name: Template name without extension, e.g. "structurer".
        **kwargs: Values to fill `{placeholder}` fields in the template.

    Returns:
        The rendered prompt text.

    Raises:
        FileNotFoundError: If no template named `name` exists.
    """
    return load_prompt(name).format(**kwargs)
