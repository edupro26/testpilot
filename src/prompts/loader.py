"""Loading and rendering of prompt templates."""

from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent / "templates"


def load_prompt(name: str) -> str:
    """Read the raw contents of a prompt template.

    Args:
        name: Template name without extension, e.g. "structurer".

    Returns:
        The raw template text.
    """
    return (_PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8")


def render_prompt(name: str, **kwargs: str) -> str:
    """Load a prompt template and fill in its placeholders.

    Args:
        name: Template name without extension, e.g. "structurer".
        **kwargs: Values to fill `{placeholder}` fields in the template.

    Returns:
        The rendered prompt text.
    """
    return load_prompt(name).format(**kwargs)
