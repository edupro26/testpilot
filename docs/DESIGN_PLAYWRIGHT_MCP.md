# Design — Level 2 driven by Playwright MCP

> Branch: `feat/experiment-playwright-mcp`. A **proposal**, not an accepted
> plan. Evidence for every claim here is in
> [`EXPERIMENT_PLAYWRIGHT_MCP.md`](./EXPERIMENT_PLAYWRIGHT_MCP.md); this
> document only designs on top of it.
>
> This is an **alternative to M4 (ARIA snapshots)** in `PLAN.md`, not a
> replacement for it. Both solve the same problem — the two are a choice.

## The shift

Today Level 2 asks the LLM to *name a selector* from a page dump, then
checks whether that selector resolves. The failure mode is structural: the
model is guessing at a static document, so duplicate matches, stale
selectors and overlay interference are all found late, or not at all.

Under this design the LLM instead **drives a real browser** through
Playwright MCP, one step at a time. It never writes Playwright code — MCP
reports the exact code it ran for every successful action, and the model's
job narrows to *selecting* which of those emitted lines belong to the step.

Level 2's output stops being selector metadata and becomes **validated
Playwright statements**. Level 3 drops to assembly.

```
                 drives (explores, may fail)
   LLM ──tools──► MCP browser   (Node, @playwright/mcp)
    │                 │
    │                 └── emits "Ran Playwright code" (Python)
    │                              │
    └── selects which lines ───────┘
                   │
                   ▼
            harvested statements
                   │
                   ▼  executed verbatim
            Replay browser  (Python, sync Playwright)  ◄── ground truth
```

## Why two browsers

The MCP browser is the agent's workspace: it contains failed clicks,
exploratory navigation, and MCP's own implicit behaviour. Notably **MCP
waits 500ms after every action** (`--timeout-settle`) and that wait is
*not* in the emitted code. Code that works there is not yet known to work
on its own.

The replay browser is the contract. It is plain Python Playwright, it
executes nothing but validated statements, and its state is therefore
exactly what the generated script will produce when `pytest` runs it.

**Replay is cumulative, not per-step-from-scratch.** One replay browser
opens at the start of a test case and executes each step's statements as
they are validated. That is O(n) rather than O(n²) page loads, and it is
*more* faithful than replaying `0..i` in a fresh context each time, because
the state each step sees is the real accumulated state of the script. The
prefix is only re-run after a failure, to clear a half-executed step.

## The per-step loop

For each execution step, in order, across all modules:

1. **Explore.** A fresh LLM conversation, system prompt + the step text,
   with the allowlisted MCP tools bound. The model finds elements, acts,
   and recovers from errors. It ends by calling `step_done`.
2. **Harvest.** `step_done` returns the statements the model claims belong
   to the step. Every one is checked against the set of lines MCP actually
   emitted this step (see *Verbatim enforcement*). Anything unmatched is
   rejected outright.
3. **Replay.** The rendered statements run in the replay browser. A
   `PlaywrightError` here means the code does not stand on its own.
4. **Judge.** One LLM call, no tools: *does this code accomplish what the
   step asked?* This is the only question replay cannot answer — code that
   runs cleanly while testing the wrong thing.
5. **Commit.** The statements are written into the step and the loop moves on.

On a replay or semantic failure, the loop retries **once** with the failure
text as feedback, then aborts — matching functional req 10.

> **Known limitation, stated plainly.** MCP has already performed the step
> in its own browser, so a retry resumes from the post-step state rather
> than re-attempting cleanly. The retry prompt says so explicitly. Properly
> restoring MCP to the pre-step state is listed under *Open questions*; it
> is not solved here.

## Decision: the async boundary

**The MCP session runs in a background thread with its own event loop,
behind a synchronous facade. Everything else stays synchronous.**

This is forced, not stylistic. The harvested code is the **sync** Playwright
API:

```python
page.get_by_role("button", name="Consent").click()
```

Replaying that under async Playwright would require injecting `await`
before every call, including `await expect(...)` — string rewriting that
destroys the verbatim property the whole design rests on. So replay must
use sync Playwright.

Sync Playwright objects are bound to their creating thread, and that thread
must not be running an event loop. Since the `mcp` SDK is async-only, one
of the two has to move. Moving MCP is the smaller change:

> **Both halves were spiked before this was written.** A `ClientSession`
> held open in a background thread, driven from the main thread through a
> sync facade (`run_coroutine_threadsafe`), listed tools and ran a 3-action
> sequence, then shut down cleanly. In the same process afterwards, the
> harvested lines were `exec`'d verbatim against a sync Playwright page
> with `{"page", "expect", "PWTimeout"}` in scope — including an
> `expect(...)` assertion and an `optional` block whose banner was absent
> (it did not raise). Neither is assumed.

- `src/extractor/mcp.py` is the only module containing `async` at all, and
  it is hidden behind a sync interface.
- The extractor, validator, generator, `main.py` and the entire test suite
  stay sync. No `pytest-asyncio`.
- The alternative — `asyncio.run()` at the Level 2 boundary with replay
  pushed through a single-worker `ThreadPoolExecutor` — works, but turns
  every Level 2 test async for no gain.

## JSON contract

`ExtractedData` is replaced. `IdentifierType` and `ElementType` both go:
the code is now self-describing, so neither carries information any more.

```python
class StatementKind(StrEnum):
    ACTION = "action"        # a harvested line, executed as-is
    ASSERTION = "assertion"  # a harvested locator, wrapped in expect(...)


class Assertion(StrEnum):
    TO_BE_VISIBLE = "to_be_visible"
    TO_CONTAIN_TEXT = "to_contain_text"
    TO_HAVE_TEXT = "to_have_text"
    TO_HAVE_VALUE = "to_have_value"


class StepStatement(BaseModel):
    """One validated Playwright statement belonging to an execution step."""

    kind: StatementKind
    # ACTION: the full emitted line, verbatim.
    # ASSERTION: the emitted locator expression only, with `.hover()` stripped.
    code: str
    assertion: Assertion | None = None   # ASSERTION only
    expected: str | None = None          # ASSERTION only, for text/value checks
    # Best-effort: the element may legitimately be absent on a later run.
    # A consent banner is the motivating case.
    optional: bool = False
    why: str


class ExecutionStep(BaseModel):
    step: str
    statements: list[StepStatement] = Field(default_factory=list)
```

`TestCase` and `Module` are unchanged, so Level 1 is untouched. `Module.url`
becomes advisory: the agent harvests its own `page.goto(...)` when it
navigates, and a module reached by clicking produces no `goto` at all.

### Why assertions are split this way

MCP emits code for *actions* only; a verification step has nothing to
harvest. The workaround is to hover the element, which emits its locator as
a side effect, then strip `.hover()`.

That leaves the `expect(...)` wrapper itself to be composed — so the
contract splits the risk. The **locator stays verbatim** (the part that is
hard to get right and must be proven against a live page), while the
wrapper is **template-rendered** from an enum (the part that is trivial and
must not be free-written).

Assertions default to the strongest form the step supports. When the step
quotes text — *"Verify that the error message 'Your email or password is
incorrect!' is visible"* — the renderer emits `to_contain_text` with the
**full quoted string from the step**, not `to_be_visible` on the locator.
This matters because Playwright's locator generator truncates: hovering
that paragraph yields `get_by_text("Your email or password is")`, dropping
"incorrect!". Asserting on the step's own wording recovers what truncation
lost.

## Rendering: one function, both stages

```python
def render_statement(statement: StepStatement) -> str: ...
```

The Validator renders a statement to replay it; the Generator renders the
same statement to write it into the script. **Both call this function.**
If they diverge, "validated" stops meaning "shipped".

| Input | Output |
|---|---|
| action | `page.get_by_role("link", name="X").click()` |
| action, `optional` | `try/except` with a short scoped timeout (below) |
| assertion, `to_be_visible` | `expect(page.get_by_text("X")).to_be_visible()` |
| assertion, `to_contain_text` | `expect(page.get_by_text("X")).to_contain_text("full text")` |

The `optional` wrapper must not be a bare `try/except`:

```python
try:
    page.get_by_role("button", name="Consent").click(timeout=5000)
except PlaywrightTimeoutError:
    pass
```

Two details are load-bearing. The **short explicit timeout** stops an absent
banner from burning Playwright's 30s default on every run. Catching
**`PlaywrightTimeoutError` rather than `Exception`** stops the guard from
silently swallowing real failures — a bare `except Exception` would hide a
genuine bug in an optional step forever.

## Verbatim enforcement

"Harvest, never free-write" is currently a sentence in a prompt, and the
replay step `exec`s whatever comes back. That is not good enough.

The extractor records every line MCP emitted under `### Ran Playwright
code` for a **successful** call during this step's loop. `step_done` is
then checked against that set:

- an `ACTION` statement must match an emitted line exactly;
- an `ASSERTION` statement's `code` must match an emitted `.hover()` line
  with `.hover()` stripped.

Anything else is rejected and the step fails. This is one set-membership
check, and it converts the central guarantee of the design from a prompt
instruction into something a unit test can assert. It also closes the
arbitrary-code-execution hole that `exec` would otherwise open.

## Module layout

```
src/
├── extractor/
│   ├── mcp.py           # NEW: stdio MCP client, sync facade, tool allowlist
│   ├── agent.py         # NEW: the per-step explore loop + harvest check
│   └── service.py       # Extractor: drives agent.py step by step
├── validator/
│   ├── replay.py        # NEW: sync Playwright replay browser
│   └── service.py       # Validator: replay + the semantic LLM call
├── generator/
│   ├── render.py        # NEW: render_statement(), shared with the Validator
│   └── service.py       # Generator: deterministic assembly
├── llm/
│   ├── protocol.py      # + conversation/tool-calling interface
│   └── provider/*.py    # each provider implements it
└── model/
    ├── enums.py         # - IdentifierType, - ElementType, + StatementKind, + Assertion
    └── test_case.py     # ExtractedData -> StepStatement
```

### `extractor/mcp.py`

Owns the subprocess and the background event loop. Exposes a narrow
protocol so tests can substitute a fake and **no test ever spawns `npx`**
(non-functional req 7):

```python
class MCPToolset(Protocol):
    def list_tools(self) -> list[McpTool]: ...
    def call_tool(self, name: str, arguments: dict) -> McpResult: ...
```

**Tool allowlist** — ten tools, deliberately narrow:

```
browser_navigate  browser_click      browser_type       browser_fill_form
browser_select_option  browser_press_key  browser_hover
browser_wait_for  browser_snapshot   browser_find
```

Two exclusions are deliberate and must not be relaxed:

- **`browser_run_code_unsafe`** is RCE-equivalent by Microsoft's own
  description.
- **`browser_evaluate`** ignores `--codegen python` and emits JavaScript,
  which would leak into a Python script.

MCP's raw `input_schema` passes straight through as the provider's tool
schema, after stripping `$schema` and `additionalProperties` — verified
accepted by Azure.

### `llm/protocol.py`

The current protocol is `complete(system_prompt, user_prompt, json_mode) -> str`.
Tool calling needs conversational state, so rather than a neutral `Message`
model — which would have to carry tool-call ids and provider-specific
reasoning items across three SDKs without loss — **each provider owns its
own message format** behind a conversation object:

```python
class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict


class ToolUseResponse(BaseModel):
    text: str | None
    tool_calls: list[ToolCall]


class Conversation(Protocol):
    def send(self, *, tool_results: list[ToolResult] | None = None) -> ToolUseResponse: ...


class LLMProvider(Protocol):
    def complete(self, *, system_prompt: str, user_prompt: str,
                 json_mode: bool = False) -> str: ...
    def start_conversation(self, *, system_prompt: str, user_prompt: str,
                           tools: list[dict]) -> Conversation: ...
```

Notes:

- A **fresh conversation per step** keeps context small. The live spike took
  6 short turns for one step, so snapshot pruning is unnecessary — provided
  the prompt steers the model to `browser_find` over full snapshots. An
  unbounded `browser_snapshot` on a busy page is ~10k tokens.
- `RetryingLLMProvider` must wrap the new method too, or tool-calling
  traffic silently loses rate-limit protection.
- `MockProvider` gains a scripted tool-call sequence so the suite runs
  offline.
- **`temperature=0` must not be sent.** The current `gpt-5.5` deployment
  rejects it outright. (`Extractor._extra_args()` hardcodes it today and
  would 400.)

## Validator

Two checks, in order:

1. **Replay** — render the step's statements and `exec` them in the replay
   browser with `{"page": page, "expect": expect}`. Deterministic, and it
   is the same code the script will ship.
2. **Semantic** — one LLM call: *does this accomplish the step?* Narrowed
   to what replay cannot see. "Does the locator resolve" is no longer its
   job; "is this testing the right thing" is.

The deterministic DOM machinery — `uniqueness.py`, `count_dom_matches`,
`element_type_is_plausible` — is deleted. Replay subsumes all of it:
a selector matching zero or two elements raises at execution.

## Generator

Assembly becomes **deterministic**. The LLM does not emit code.

This is a strengthening, not a shortcut: every statement has already been
proven against a live browser, and letting a model rewrite them discards
that proof. The template produces imports, the test function, each step as
a comment followed by its rendered statements, and nothing else.

The LLM keeps one narrow, text-only job: naming the test function and
writing its docstring. It never touches a statement.

Consequently `_inject_overlay_dismissal`, `_MARKER_*`, the `# MODULE i`
marker protocol and the `crawl4ai.js_snippet` import all go. Consent
handling is now an ordinary `optional` statement that was validated like
any other — which is a better answer to functional req 6 than injecting
`remove_overlay_elements.js` and hoping the live page matches.

## Settings

```
MCP_COMMAND          # absolute path to the node/npx binary
MCP_PACKAGE          # pinned, e.g. @playwright/mcp@0.0.83 -- never @latest
MCP_BROWSER          # chromium (the default `chrome` channel is not installed)
MCP_HEADLESS         # default true
MCP_OUTPUT_DIR       # or it writes .playwright-mcp/ into the cwd
MCP_MAX_TURNS        # tool-iteration cap per step
```

`MCP_COMMAND` must be an absolute path: on WSL a bare `npx` resolves to the
*Windows* binary under `/mnt/c`, which would drive a Windows browser across
the filesystem boundary.

## Testing

| Layer | Approach |
|---|---|
| `mcp.py` | Fake `MCPToolset`. No subprocess, no `npx`, ever. |
| `agent.py` | Scripted `MockProvider` tool calls + fake toolset. Must cover: a rejected free-written statement, and an error-then-recover sequence. |
| `render.py` | Pure function — table-driven over every kind/assertion/optional combination. |
| `replay.py` | Real sync Playwright against a `data:` URL or a local fixture page; no network. |
| `generator` | Golden-file assembly from a fixed `TestCase`. |

The verbatim check deserves its own test: *a `step_done` statement that was
never emitted is rejected.* That is the security boundary around `exec`.

## What gets deleted

`src/extractor/crawler.py`, `records.py`, `replay.py`, `scraping.py`,
`src/validator/uniqueness.py`, their tests, the `crawl4ai`/`cssselect`/`lxml`
dependencies, `IdentifierType`, `ElementType`, and the Generator's overlay
injection.

Net: this removes more than it adds. Much of it overlaps with what
`feat/extractor-aria-rework` already deleted — relevant if that branch
lands first.

## Risks

- **Cost and latency.** One agent loop per step, each several turns. The
  single spiked step took 6 turns. A 7-step case is a different order of
  magnitude from today's one-call-per-module extraction. Needs measuring
  before this is called viable.
- **Two browser installs.** Node Playwright wants its own chromium build
  (1247) separate from the Python one (1234/1243) — ~300MB extra, and Node
  itself, in any future Docker image (M5).
- **A fast-moving dependency.** 0.0.83 ships 25 tools; `main` has 70+ and
  the published docs describe tools that do not exist in the release.
  `browser_generate_locator` would replace the hover trick when it lands.
- **Non-determinism.** The agent may harvest a different-but-valid locator
  across runs. Replay proves each one works; it does not make them stable.

## Open questions

1. **Restoring MCP to the pre-step state on retry.** Currently out of
   scope, with the limitation documented instead.
2. **Deduplicating `optional` statements across steps.** A consent click
   harvested into step 3 should not reappear in step 5.
3. **Per-step vs per-module conversations** if token cost proves too high.
4. Whether `Module` survives at all once `url` is advisory.
