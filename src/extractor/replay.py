"""Replay: recover a step's identifiers via a targeted, replayed re-crawl.

If a step comes up empty and an earlier step has an actionable identifier,
a fresh crawl replays every earlier action via JS and re-extracts just that
step -- recovering elements that only exist after an interaction.
"""

import json
import logging

from src.exceptions import CrawlerError
from src.extractor.records import RunCrawl, parse_records, to_extracted_data
from src.model.enums import ElementType, IdentifierType
from src.model.test_case import ExecutionStep, ExtractedData, Module
from src.prompt_loader import render_prompt

logger = logging.getLogger(__name__)

_FILLABLE_TYPES = {ElementType.INPUT, ElementType.DROPDOWN}
_CLICKABLE_TYPES = {ElementType.BUTTON, ElementType.LINK, ElementType.CHECKBOX}


def replay(
    result_module: Module,
    html_by_step: list[str],
    keywords: frozenset[str],
    feedback_section: str,
    run_crawl: RunCrawl,
) -> tuple[Module, list[str]]:
    """Re-crawl and re-extract any step that came up empty, replaying prior actions.

    Replay never fails the module: a failed crawl or action just leaves
    that step's extracted_data empty.

    Args:
        result_module: The module after its one static crawl and extraction.
        html_by_step: HTML each step's identifiers were extracted from so far.
        keywords: The module's relevance signal, reused for replay crawls.
        feedback_section: Rendered retry-feedback block for replay prompts.
        run_crawl: The crawl-and-extract callable to use for each replay.

    Returns:
        The module with any recovered steps filled in, and each step's
        actual source HTML (updated for recovered steps).
    """
    steps = list(result_module.execution_steps)
    for index in range(1, len(steps)):
        if steps[index].extracted_data:
            continue
        recovered = _replay_step(
            index, steps, result_module.url, feedback_section, keywords, run_crawl
        )
        if recovered is not None:
            steps[index], html_by_step[index] = recovered

    replayed_module = Module(
        url=result_module.url,
        description=result_module.description,
        execution_steps=steps,
    )
    return replayed_module, html_by_step


def _replay_step(
    index: int,
    steps: list[ExecutionStep],
    url: str,
    feedback_section: str,
    keywords: frozenset[str],
    run_crawl: RunCrawl,
) -> tuple[ExecutionStep, str] | None:
    """Try to recover step `index`'s identifiers via a targeted re-crawl.

    Returns None on any failure (nothing to replay, crawl fails, action
    fails, still empty) -- the caller then just leaves the step as-is.
    """
    replay_js = _replay_js(steps[:index])
    if not replay_js:
        return None

    step_instruction = render_prompt(
        "extractor",
        numbered_steps=f"{index}. {steps[index].step}",
        feedback_section=feedback_section,
    )
    try:
        extraction = run_crawl(url, step_instruction, keywords, replay_js)
    except CrawlerError:
        logger.warning("Replay crawl failed for step %d", index)
        return None
    if not extraction.js_ok:
        logger.warning("Replay action failed for step %d", index)
        return None

    records = [r for r in parse_records(extraction.records) if r.step_index == index]
    if not records:
        return None

    new_step = ExecutionStep(
        step=steps[index].step,
        extracted_data=[to_extracted_data(r) for r in records],
    )
    return new_step, extraction.html


def _replay_js(steps: list[ExecutionStep]) -> list[str]:
    """Return one replay script per actionable identifier across `steps`, in order."""
    return [
        _action_js(item)
        for step in steps
        for item in step.extracted_data
        if _is_actionable(item)
    ]


def _is_actionable(item: ExtractedData) -> bool:
    """Whether `item` can drive a replayed click/fill action.

    TEXT identifiers are excluded even for otherwise-actionable types: the
    text matcher resolves to the leaf-most element (e.g. the <span> inside
    a <button>), not a reliably actionable node.
    """
    if item.identifier_type is IdentifierType.TEXT:
        return False
    if item.type in _CLICKABLE_TYPES:
        return True
    return item.type in _FILLABLE_TYPES and item.input_value is not None


def _action_js(item: ExtractedData) -> str:
    """Return a JS snippet replaying `item`'s action (click or fill)."""
    guard = (
        f"const el = {_selector_js(item.identifier_type, item.identifier_tracking)};"
        f"if (!el) {{ throw new Error('replay target not found'); }}"
    )

    if item.type is ElementType.INPUT and item.input_value is not None:
        value = json.dumps(item.input_value)
        body = (
            f"el.focus(); el.value = {value};"
            f"{_dispatch_js('input')}"
            f"{_dispatch_js('change')}"
            f"el.blur();"
        )
    elif item.type is ElementType.DROPDOWN and item.input_value is not None:
        value = json.dumps(item.input_value)
        body = f"el.value = {value}; {_dispatch_js('change')}"
    else:
        body = "el.click();"

    settle = "await new Promise((resolve) => setTimeout(resolve, 400));"
    return guard + body + settle


def _selector_js(identifier_type: IdentifierType, identifier_tracking: str) -> str:
    """Return a JS expression resolving to the element `identifier_tracking` names."""
    value = json.dumps(identifier_tracking)
    if identifier_type is IdentifierType.ID:
        return f"document.getElementById({value})"
    if identifier_type is IdentifierType.CSS:
        return f"document.querySelector({value})"
    return (
        f"document.evaluate({value}, document, null, "
        "XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue"
    )


def _dispatch_js(event_name: str) -> str:
    """Return a JS snippet dispatching a bubbling DOM event named `event_name`."""
    return f"el.dispatchEvent(new Event('{event_name}', {{bubbles: true}}));"
