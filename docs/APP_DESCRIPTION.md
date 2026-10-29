# TestPilot

TestPilot is a GenAI enabler for quick test script generation and automation. It is an LLM-powered application that, based on a specification of a test case (.md), generates a Playwright (Python) test script, which can then be executed to receive a test report. It is currently in alpha: the full pipeline works end to end, and the next features are tracked in the roadmap.

The core idea: the LLM never writes test code from a static view of the page. It **drives a real browser** through [Playwright MCP](https://github.com/microsoft/playwright-mcp), one step at a time, and keeps only the code Playwright itself reports running. Every statement is then replayed in a second, clean browser before it is accepted, so the generated script contains only code that has already been proven against the live site.

What comes next is tracked in [ROADMAP.md](./ROADMAP.md).

## Application Architecture

![Application architecture](./images/application_architecture.png)

The pipeline has three stages: the **Structurer** turns the markdown into a structured test case, the **Agent Loop** (Extractor, Playwright MCP, Validation Browser and Validator) works out and proves the code for each step, and the **Generator** assembles the validated code into a test script.

## Domain Description

### Structurer

**Input**: Markdown file (.md) containing a test case specification

```markdown
# Add item to the shopping cart

urls = ["https://www.saucedemo.com/", "https://www.saucedemo.com/inventory.html"]

## Steps

1. Launch browser and navigate to url 'https://www.saucedemo.com/'
2. Verify that the Login Section is visible successfully
3. Enter the username 'standard_user' and the password 'secret_sauce'
...
```

- `Structurer`: Module responsible for receiving the input and prompting
    the LLM to convert it into a modular JSON structure: the test case is
    split into modules (one per page/URL), each with its execution steps

**Output**: The structured test case in JSON format, with no code yet

```json
{
    "name": "...",
    "modules": [
        {
            "url": "...",
            "description": "...",
            "execution_steps": [
                {
                    "step": "...",
                    "statements": []
                }
            ]
        }
    ]
}
```

### Agent Loop (for each step)

**Input**: The structured test case

Steps run one at a time, in order, across all modules. Both browsers stay open for the whole test case, so each step starts from the state the previous steps left behind.

- `Extractor`: An LLM agent that performs the step in a live browser by
    calling Playwright MCP tools (find elements, click, type, verify, ...).
    Every successful tool call reports the exact Playwright code it ran
    (`codegen`). When done, the agent reports which of those lines belong
    to the step. It never writes code itself: a line Playwright MCP did not
    emit is rejected
- `Playwright MCP`: A Playwright MCP server (Node) the application connects
    to over HTTP. It owns the agent's browser, which is a workspace: it also
    holds failed attempts and exploratory detours
- `Validation Browser`: A separate, clean Python Playwright browser that
    runs only accepted code. Its state is exactly what the generated script
    will produce
- `Validator`: Module responsible for proving the step's code in two checks:
    1. **Replay**: run the collected code in the Validation Browser. Any
       error (an element not found, a locator matching several elements, a
       failed assertion) rejects the step
    2. **Semantic**: prompt the LLM to judge whether the code does what the
       step asked (for example, that it verifies the right message rather
       than any visible heading). On acceptance, it records a reason for
       each statement

A rejected step is retried **once**, with the rejection as feedback. Before the retry both browsers are reset: the Validation Browser re-runs every accepted statement, and Playwright MCP gets a fresh session opened at the same URL. If the retry is rejected too, the run aborts.

**Output**: The validated test case in JSON format, saved to disk before generation

```json
{
    "name": "Login User with Incorrect Credentials",
    "modules": [
        {
            "url": "http://automationexercise.com",
            "description": "Home page where the user starts ...",
            "execution_steps": [
                {
                    "step": "Launch browser and navigate to url 'http://automationexercise.com'",
                    "statements": [
                        {
                            "code": "page.goto(\"http://automationexercise.com\")",
                            "reason": "Navigates the page to the requested URL ..."
                        },
                        {
                            "code": "page.get_by_role(\"button\", name=\"Consent\").click()",
                            "reason": "Dismisses the consent popup ..."
                        }
                    ]
                }
            ]
        }
    ]
}
```

### Generator

**Input**: The validated test case

- `Generator`: Module responsible for prompting the LLM to write the
    complete `pytest-playwright` test module (docstrings, imports, test
    name, one comment per step) around the validated statements and a fixed
    locale fixture. The result must compile and must contain every
    statement and fixture line unchanged and in order; otherwise the run
    fails. There is no retry, and the validated JSON is already on disk

**Output**: The executable test script file

```python
@pytest.fixture(scope="session")
def browser_context_args(browser_context_args: dict) -> dict:
    """Pin the locale these locators were validated under."""
    return {**browser_context_args, "locale": "en-US"}


def test_login_user_with_incorrect_credentials(page: Page) -> None:
    """Verify that incorrect login credentials show an error message."""
    # Launch browser and navigate to url 'http://automationexercise.com'
    page.goto("http://automationexercise.com")
    page.get_by_role("button", name="Consent").click()

    # Verify that the home page is visible successfully
    expect(page.get_by_role("heading", name="AutomationExercise")).to_be_visible()
    ...
```

## Requirements

### Functional
1. Accept a markdown test-case specification file as CLI input.
2. The Structurer converts the markdown into the structured test case via one LLM call.
3. For each execution step, in order, the Extractor performs the step in a live browser through Playwright MCP, using only an allowlisted set of tools, and reports the code lines that belong to the step. Only lines emitted by a code-generating tool during that step are accepted.
4. The Validator replays each step's code in the Validation Browser, then judges via an LLM call whether it accomplishes the step, before the step is accepted.
5. On a rejection, both browsers are reset and the step is retried once with the rejection as feedback; a second rejection aborts the run with a `ValidatorError`. An Extractor failure (no completion within `MCP_MAX_TURNS`, a malformed report, or a line Playwright MCP never ran) aborts the run with an `ExtractorError`.
6. Popups (cookie-consent banners, newsletters, surveys) are dismissed in the step that makes them appear, as ordinary validated statements. There is no site-specific or injected overlay handling.
7. The Generator turns the validated test case into a single executable Playwright (Python) test file, using the `pytest-playwright` `page` fixture, with every validated statement copied unchanged. A script that drops or alters a statement or does not compile aborts the run with a `GeneratorError`.
8. The CLI runs the full pipeline as a single command: `uv run python -m src.main <path.md>`. Playwright is the only target framework.
9. The pipeline writes the validated JSON and the generated script under `output/<input's parent folder name>/`, both named after the input file (e.g. `examples/automation/test_x.md` -> `output/automation/test_x.json` and `output/automation/test_x.py`). The JSON is written before generation, so a generation failure never loses it.
10. The LLM provider is selectable via `LLM_PROVIDER`: `azure_openai` (the primary target) or `mock` (offline development and testing).
11. All three browsers (Playwright MCP's, the Validation Browser and the generated script's) use the same locale, so locators found by their text match at run time.

### Non-functional
1. Python ≥3.13, `uv`-only dependency management, no `pip`.
2. All functions/methods carry full type hints; JSON contracts are Pydantic v2 models.
3. Code passes the repo's ruff configuration (line-length 88, Google docstrings, double quotes) with zero errors.
4. Secrets are sourced only from environment variables/`.env`, never hardcoded; `.env` stays gitignored.
5. No out-of-band authentication: a page behind a login is reachable only if the test case's own steps log in.
6. Generated scripts must pass `uv run pytest` against the live site they were generated from, for the demoed examples.
7. Each stage is unit-testable offline via the mock LLM provider and a fake MCP server, with no live network or LLM calls.
8. Logging uses the standard `logging` module (not `print`), level controlled by `LOG_LEVEL`, with clear per-stage log lines.
9. Single-user local CLI tool; no persistence layer or multi-tenant concerns in scope.
10. The application connects to an already running Playwright MCP server rather than spawning one, and fails at startup with a clear error if the server is unreachable or does not offer every allowlisted tool.

## Design Decisions

### Collect, never write

The Extractor's LLM does not author Playwright code. It drives the browser, and Playwright MCP reports the code each successful action ran, which is the same generator Playwright's own `codegen` uses. The agent's only job at the end of a step is to *select* which of those lines belong to it, leaving out failed attempts and detours. A line that was never emitted is rejected, which is also the safety boundary around replaying code with `exec` in the Validation Browser.

Only tools that emit Python are collectable (`COLLECTABLE_TOOLS` in `src/extractor/mcp/constants.py`): navigation, click, hover, type, fill, select, and the `browser_verify_*` assertions. Other tools (find, snapshot, evaluate, wait) still help the agent explore, but they emit no code or JavaScript whatever `codegen` says, so their code is never collected.

Two traits of that generator show up in the scripts:
- It prefers test-id attributes (`data-testid`, `data-test-id`, `data-test`) when the element has one.
- It shortens long text (over 30 characters) to a word-bounded prefix, e.g. `get_by_text("Your email or password is")`. The full text was checked against the live page during extraction, so the Validator accepts the prefix.

### Two browsers

The Playwright MCP browser is the agent's workspace and holds whatever the agent did while exploring. Playwright MCP also waits briefly after every action, and that wait is not in the emitted code. Code that works there is therefore not yet known to work on its own.

The Validation Browser is the contract: plain Python Playwright running nothing but accepted code. Replay is cumulative (one browser for the whole test case, each step's code added as it is accepted), so it reproduces exactly the state the generated script will see.

### Retry and reset

Before a retry both browsers are reset, so the agent sees the page as the script would, including a consent banner it had already dismissed. The Validation Browser is restarted and re-runs the accepted code; Playwright MCP gets a fresh session (each session has its own in-memory profile) and is sent to the URL the Validation Browser ended on. Only the URL carries over to Playwright MCP, so the agent is told to redo any setup the step depends on (a login, a cart) without reporting it.

### The Generator only assembles

Every statement was proven against a live browser, and letting an LLM rewrite them would discard that proof. The LLM writes everything around them (docstrings, imports, test name, step comments), and a deterministic check rejects the script if any validated line or fixture line is missing, changed or out of order.

### Locale

Sites translate their text by the browser's `Accept-Language`, and most locators are text-based. The Playwright MCP browser's locale is set in `mcp/config.json`; `BROWSER_LOCALE` sets it for the Validation Browser and is pinned into the generated script by a `browser_context_args` fixture. The two must match.

### Playwright MCP version

The server runs at `@latest`. The tool surface changes between releases, so the application checks at startup that every allowlisted tool is offered, turning an upstream change into an immediate, named failure. `browser_run_code_unsafe` (arbitrary code in the server process) and `browser_close` (would end the session the pipeline owns) are never exposed.

## Playwright MCP Server

The application needs a running Playwright MCP server, started with:

```
npx @playwright/mcp@latest --config ./mcp/config.json
```

| `mcp/config.json` key | Why it matters |
|---|---|
| `codegen: "python"` | Makes every tool result report the Python statement it ran, which is what the Extractor collects. It is a string, not an object. |
| `capabilities: ["testing"]` | Adds the `browser_verify_*` assertion tools; without them a verification step has nothing to collect. |
| `browser.contextOptions.locale` | Must match `BROWSER_LOCALE` (see *Locale*). |
| `browser.browserName: "chromium"` | The default `chrome` channel is usually not installed. |
| `browser.isolated: true` | A fresh in-memory profile per session, so consent banners reappear every run and the retry reset works. |
| `server.port` | Where the application connects (`MCP_URL`). |
| `outputDir` | Otherwise the server writes `.playwright-mcp/` into the working directory. |

## Known Limitations

- **Waits are not collected.** Playwright MCP settles after every action, and that wait is not in the emitted code. Pages that render content late can pass in Playwright MCP and fail on replay (see [ROADMAP.md](./ROADMAP.md)).
- **One retry, and only for rejections.** A step gets a single retry after a Validator rejection; an Extractor failure aborts the run immediately.
- **Single-line statements.** Collected code is split line by line, so a statement spanning several lines would be rejected.
- **One locale per run.** The Playwright MCP locale is fixed when the server starts, so a run covers one locale.
- **Cost and latency.** Each step is its own agent conversation of several tool calls, plus a Validator call.
- **Non-determinism.** Replay proves each statement works; it does not guarantee the same locator is chosen on every run.
- **Two Playwright installs.** Playwright MCP (Node) and the Validation Browser (Python) each need their own browser build.

## Repository Structure

```
docs/
├── images/                         # images for documentation
├── APP_DESCRIPTION.md              # this document
└── ROADMAP.md                      # what is planned next
examples/                           # sample test-case markdown inputs, grouped by
|                                     target site (e.g. examples/automation/)
mcp/
└── config.json                     # Playwright MCP server configuration
output/                             # gitignored, per-run generated artifacts
|                                     (JSON + script), mirroring examples/'s
|                                     per-site subfolders
prompts/                            # one template per LLM call
├── structurer.md
├── extractor.md
├── validator.md
└── generator.md
src/
├── extractor/
|   ├── mcp/
|   |   ├── constants.py            # timeouts, allowed and collectable tools,
|   |   |                             emitted-code pattern
|   |   └── server.py               # PlaywrightMCP: sync client for the MCP
|   |                                 server (HTTP, background event loop)
|   ├── agent.py                    # StepAgent: per-step tool-calling loop,
|   |                                 collects the reported statements
|   ├── service.py                  # Extractor: runs one step
|   └── utils.py                    # prompt context, step rebuilding, checks
├── generator/
|   └── service.py                  # Generator: LLM assembly + verbatim check
├── llm/                            # LLM provider abstraction
|   ├── protocol.py                 # LLMProvider protocol (completion and
|   |                                 tool-calling conversation)
|   ├── factory.py                  # get_llm_provider(settings)
|   ├── retry.py                    # rate-limit retry wrapper applied to every
|   |                                 provider
|   └── provider/                   # concrete LLMProvider implementations
|       ├── mock.py
|       ├── azure_openai.py
|       └── openai_chat.py          # Chat Completions tool-calling conversation
├── model/                          # shared JSON-contract schemas
|   └── test_case.py                # TestCase, Module, ExecutionStep, StepStatement
├── structurer/
|   └── service.py                  # Structurer: markdown -> structured JSON
├── validator/
|   ├── browser.py                  # ValidationBrowser: replays accepted code
|   └── service.py                  # Validator: replay + semantic check
├── config.py                       # pydantic-settings Settings + configure_logging()
├── exceptions.py                   # PipelineError + per-stage subclasses
├── main.py                         # CLI entrypoint and pipeline wiring
└── prompt_loader.py                # load_prompt / render_prompt
test/                               # pytest suite mirroring src/
```
