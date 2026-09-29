"""Tests for src.generator.frameworks."""

from src.generator.frameworks import FRAMEWORK_TEMPLATES
from src.model.enums import TestFramework
from src.prompt_loader import load_prompt


def test_playwright_maps_to_an_existing_prompt_template() -> None:
    """The Playwright entry points at a template that actually exists."""
    template_name = FRAMEWORK_TEMPLATES[TestFramework.PLAYWRIGHT]

    assert load_prompt(template_name)
