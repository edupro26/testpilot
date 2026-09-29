"""Registry mapping each TestFramework to its Generator prompt template."""

from src.model.enums import TestFramework

FRAMEWORK_TEMPLATES: dict[TestFramework, str] = {
    TestFramework.PLAYWRIGHT: "generator_playwright",
}
