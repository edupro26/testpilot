"""Tests for src.prompt_loader."""

import pytest
from src.prompt_loader import load_prompt, render_prompt


def test_load_prompt_reads_template() -> None:
    """The structurer template loads without error."""
    assert load_prompt("structurer")


def test_render_prompt_fills_placeholder() -> None:
    """render_prompt substitutes the given placeholder into the template."""
    rendered = render_prompt("structurer", test_case_markdown="# Example")

    assert "# Example" in rendered


def test_load_prompt_missing_template_raises() -> None:
    """Loading a nonexistent template raises FileNotFoundError."""
    with pytest.raises(FileNotFoundError):
        load_prompt("does-not-exist")
