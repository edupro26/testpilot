# GenAI-Test-Script-Automation

This project is a proof of concept with the objective of exploring and designing a GenAI enabler for quick test script generation and automation. This enabler will be a LLM-powered application that, based on a specification of a test case (.md), will generate a test script file built using a testing framework (e.g., .py, .ts, .robot, etc.), which can then be executed to receive a test report.

## Application Architecture (Prototype)

![Structure](./images/app_structure.png)

> **Note**: The diagram above labels the Level 1 module "Restructurer". This document and the codebase standardize on **Structurer** instead.

## Domain Description

### Level 1

**Input**: Markdown file (.md) containing a test case specification

- `Structurer`: Module responsible for receiving the input and prompting
    the LLM to convert and generate to JSON modular format

**Output**: A modular structure of the test case in a JSON format

```json
"name": "...",
"modules": [
    {
        "url": "...",
        "description": "...",
        "execution_steps": [
            {
            "step": "...",
            "extracted_data": []
            }
        ]
    }
]
```

### Level 2

**Input**: Level 1 output

For each module (url) inside the JSON test case:

- `Crawler`: A web crawl tool to extract data from the url
- `Extractor`: Module responsible for prompting the LLM to choose the 
    necessary data to extract for the test case
- `Validator`: Module responsible for prompting the LLM to verify
    if all the data collected is correct for the test case

**Output**: A modular structure of the test case in a JSON format 
    containing also HTML extracted data

```json
"name": "...",
"modules": [
    {
        "url": "...",
        "description": "...",
        "execution_steps": [
            {
                "step": "...",
                "extracted_data": [
                    {
                        "type": "...",
                        "request_description": "...",
                        "identifier_type": "...",
                        "identifier_tracking": "..."
                    }
                ]
            }
        ]
    }
]
```

### Level 3

**Input**: Level 2 output

- `Generator`: Module responsible for prompting the LLM to generate
    a test script file in the chosen framework

**Output**: The executable test script file

## Requirements

### Functional
1. Accept a markdown test-case specification file as CLI input.
2. Structurer converts the markdown into the Level 1 JSON via an LLM call.
3. For each module URL, the Crawler retrieves page content via Crawl4AI, restricted to publicly accessible, non-authenticated pages.
4. Extractor selects, per execution step, the UI elements needed via an LLM call, recovering via a targeted re-crawl that replays earlier steps' clicks/fills for any step whose target only exists after an interaction elsewhere on the page.
5. Validator checks each extracted identifier deterministically (DOM uniqueness, then tag/role plausibility for its claimed element type) and via an LLM call for semantic correctness, before it's accepted into the Level 2 output.
6. Generator turns the validated Level 2 JSON into a single executable Playwright (Python) test file, using the `pytest-playwright` `page` fixture. Each module's generated steps must dismiss page overlays (cookie-consent banners, popups) right after navigation, mirroring the Crawler's own `remove_overlay_elements` behavior — confirmed by a real run that a validated, correct locator can still fail at execution time if an overlay the Crawler silently removed during crawling (see `src/extractor/crawler.py`) is still present and intercepting pointer events on the live page. Reuse Crawl4AI's own `crawl4ai/js_snippet/remove_overlay_elements.js` for this rather than inventing per-site "click Accept" logic, so the executed script's effective page matches what was actually validated.
7. The CLI runs the full pipeline (Level 1 -> Level 2 -> Level 3) as a single default command — e.g. `uv run python -m src.main --framework=playwright <path.md>` — not as separate per-level subcommands. It exposes a `--framework` flag; only `playwright` is functional in this PoC (`robot`/`cypress` remain documented, not implemented).
8. The pipeline persists the Level 1 JSON, Level 2 JSON, and the generated script as separate, inspectable files per run.
9. The LLM provider is selectable via `LLM_PROVIDER` (`mock`/`anthropic`/`openai`/`azure_openai`); all four are implemented, though only `azure_openai` (this PoC's primary target) and `mock` (offline development/testing) have been exercised against a real endpoint so far — `anthropic`/`openai` are implemented and unit-tested but not yet run against real credentials.
10. On a validator failure, the pipeline retries extraction once with feedback, then aborts with a clear error. (Recovering a step via a targeted re-crawl for missing content happens inside a single extraction attempt and does not consume this retry.)

### Non-functional
1. Python ≥3.13, `uv`-only dependency management, no `pip`.
2. All functions/methods carry full type hints; JSON contracts are Pydantic v2 models.
3. Code passes the repo's ruff configuration (line-length 88, Google docstrings, double quotes) with zero errors.
4. Secrets are sourced only from environment variables/`.env`, never hardcoded; `.env` stays gitignored.
5. No authentication/session handling — crawling is scoped to public pages (documented limitation for this PoC).
6. Generated Playwright scripts must pass a structural dry run (`pytest --collect-only`) for the demoed example(s).
7. Each pipeline stage is independently unit-testable via a mock LLM provider, with no live network/LLM calls required.
8. Logging uses the standard `logging` module (not `print`), level controlled by `LOG_LEVEL`, with clear per-stage log lines.
9. Single-user local CLI tool; no persistence layer or multi-tenant concerns in scope.
10. Script execution, test-report generation, and non-Playwright generators are explicitly out of scope for this PoC (future roadmap items only).

### Supported Test Frameworks

- Playwright: implemented in this PoC (Python, via `pytest-playwright`)
- Robot Framework: documented future target, not implemented in this PoC
- Cypress: documented future target, not implemented in this PoC
- Selenium: documented future target, not implemented in this PoC

## Repository Structure

```
docs/
├── images/                         # images for documentation
└── PLAN.md                         # Project Planning and roadmap
output/                             # gitignored, per-run generated artifacts (JSON + script)
resources/
├── examples/                       # sample test-case markdown inputs for demos
└── prompts/                        # one template per pipeline stage
|   ├── structurer.md
|   ├── extractor.md
|   ├── validator.md
|   └── generator_playwright.md
src/
├── extractor/                      # Level 2
|   ├── crawler.py                  # Crawler, CrawlResult (Crawl4AI wrapper;
|   |                                 forces single-chunk extraction, runs
|   |                                 replayed JS for replay-based recovery)
|   ├── scraping.py                 # custom scraping strategy (keyword-aware
|   |                                 content trimming only -- deliberately
|   |                                 does not deduplicate structurally-
|   |                                 identical elements, since a page can
|   |                                 legitimately repeat one, e.g. carousel
|   |                                 slides, and collapsing them would hide
|   |                                 real non-uniqueness from the Validator)
|   ├── records.py                  # ExtractedRecord, CrawlExtraction, RunCrawl --
|   |                                 data shapes shared by service.py and
|   |                                 replay.py
|   ├── replay.py                   # replay(): recovers a step's identifiers
|   |                                 via a targeted re-crawl that replays
|   |                                 earlier steps' actions (click/fill), if
|   |                                 the step comes up empty
|   └── service.py                  # Extractor: runs the base crawl + LLM
|                                     extraction, then delegates recovery
|                                     to replay.py
├── generator/                      # Level 3
|   ├── service.py
|   └── frameworks.py               # TestFramework -> prompt template registry
|                                     (playwright only, for now)
├── llm/                            # LLM provider abstraction
|   ├── protocol.py                 # LLMProvider protocol
|   ├── factory.py                  # get_llm_provider(settings)
|   ├── retry.py                    # RetryingLLMProvider: rate-limit retry
|   |                                 wrapper applied to every provider
|   └── provider/                   # concrete LLMProvider implementations
|       ├── mock.py
|       ├── azure_openai.py
|       ├── openai.py
|       └── anthropic.py
├── model/                          # shared JSON-contract schemas (cross-stage)
|   ├── enums.py                    # ElementType, IdentifierType, TestFramework
|   └── test_case.py                # TestCase, Module, ExecutionStep, ExtractedData
|                                     (one shape for Level 1 and Level 2 — Level 1
|                                     leaves execution_steps[].extracted_data empty)
├── structurer/                     # Level 1
|   └── service.py
├── validator/                      # Level 2
|   ├── service.py                  # Validator, IdentifierVerdict, ValidationResult
|   └── uniqueness.py               # deterministic DOM checks: uniqueness +
|                                     tag/role plausibility per element type
├── cli.py                          # typer app: `generate-script` command
├── config.py                       # pydantic-settings Settings + configure_logging()
├── exceptions.py                   # PipelineError + per-stage subclasses, ConfigurationError
├── main.py                         # CLI entrypoint wiring
├── pipeline.py                     # orchestrator: Level1 -> Level2 (per-module loop) -> Level3
└── prompt_loader.py                # load_prompt / render_prompt
test/                               # pytest suite mirroring the modules above
```

## Roadmap

- [x] **M0 — Scaffolding**: dependencies added to `pyproject.toml` (`pydantic`, `pydantic-settings`, `python-dotenv`, `openai`, `crawl4ai`, `typer`; dev: `pytest`, `pytest-mock`, `playwright`, `pytest-playwright`), `config.py` (incl. logging setup), prompt loader + structurer template stub (the other stages' templates are added per-milestone as each service is built), test scaffolding, `.gitignore` update for `output/`.
- [x]  **M1 — Structurer (Level 1) against Azure OpenAI**: LLM provider abstraction, Level 1 models, Structurer service + prompt. Demo: run against `LLM_PROVIDER=mock` (offline) and `LLM_PROVIDER=azure_openai` (real), both produce valid Level 1 JSON.
- [x] **M2 — Crawler + Extractor + Validator (Level 2)**: Crawl4AI wrapper (content-aware HTML trimming, forced single-chunk extraction to avoid Crawl4AI's own unthrottled concurrent-chunk LLM calls), Level 2 models, Extractor with replay-based recovery (replays earlier steps' clicks/fills via a targeted re-crawl to recover elements that only exist after an interaction, e.g. a submit error message), Validator with deterministic uniqueness + tag/role plausibility checks plus an LLM call for semantic judgment, and a shared LLM-provider retry/backoff wrapper. Demo: Level 1 -> Level 2 against a real public page whose test case includes a step revealed only after a form submission, producing real extracted and validated element locators.
- [ ] **M3 — Generator (Level 3, Playwright)**: Generator service + prompt targeting the Playwright Python sync API (`pytest-playwright` `page` fixture). Demo: a hand-authored Level 2 JSON fixture produces a `.py` test file that passes a `pytest --collect-only` dry run.
- [ ] **M4 — CLI + end-to-end wiring**: `pipeline.py`, `cli.py`, a single default command (`uv run python -m src.main --framework=playwright <path.md>`) running Level 1 -> Level 2 -> Level 3 end-to-end, a worked example under `examples/`. Demo: one CLI run against a real page, fully live (Azure OpenAI + Crawl4AI), producing a script the reviewer runs manually with `pytest`.
- [ ] **M5 (stretch, future)**: script execution + report ingestion, Robot Framework/Cypress generators, authenticated-page support, optional integration test suite, optional flags to stop the pipeline early (e.g. after Level 1 or Level 2) for debugging.
