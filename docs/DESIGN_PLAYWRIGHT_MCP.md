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
class StepStatement(BaseModel):
    """One validated Playwright statement belonging to an execution step."""

    # The full line MCP emitted, verbatim. Actions and assertions alike:
    #   page.get_by_role("link", name="Signup / Login").click()
    #   expect(page.get_by_role("heading", name="Login")).to_be_visible()
    code: str
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

### Assertions need no special handling

The `testing` capability (see *MCP transport*) adds
`browser_verify_element_visible`, `browser_verify_text_visible`,
`browser_verify_value` and `browser_verify_list_visible`. These **execute
the assertion against the live page and emit it as Python**:

```
browser_verify_element_visible {"role": "heading", "accessibleName": "Login to your account"}
→ ### Ran Playwright code
  expect(page.get_by_role("heading", name="Login to your account")).to_be_visible()
```

So a verification step harvests exactly like an action step. There is no
`kind` discriminator, no `Assertion` enum, no composed wrapper and no
truncation problem — the contract is **one verbatim line, always**.

A failing verification returns `isError=True` with a terse reason (`Text
not found`), giving the agent the same recover-and-retry signal it already
gets from a failed click.

> An earlier draft harvested assertion locators via `browser_hover` and
> composed the `expect(...)` wrapper from an enum, because the published
> docs list these tools but `--help` does not. They do exist — see the
> transport section. The hover workaround is dropped.

`browser_generate_locator` is **not** used: it returns JavaScript syntax
(`getByRole('heading', { name: '...' })`) regardless of `--codegen python`.

## Rendering: one function, both stages

```python
def render_statement(statement: StepStatement) -> str: ...
```

The Validator renders a statement to replay it; the Generator renders the
same statement to write it into the script. **Both call this function.**
If they diverge, "validated" stops meaning "shipped".

| Input | Output |
|---|---|
| statement | its `code`, unchanged |
| statement, `optional` | `try/except` with a short scoped timeout (below) |

With assertions now harvested whole, rendering is the identity function in
every case but `optional`. That is the point: the less this function does,
the less can drift between what was validated and what ships.

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
code` for a **successful** call during this step's loop. Each `step_done`
statement must match one of those lines exactly, or the step fails.

This is one set-membership check — simple precisely because assertions are
now harvested whole rather than reassembled. It converts the central
guarantee of the design from a prompt instruction into something a unit
test can assert, and closes the arbitrary-code-execution hole that `exec`
would otherwise open.

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
    ├── enums.py         # - IdentifierType, - ElementType (both now redundant)
    └── test_case.py     # ExtractedData -> StepStatement
```

### `extractor/mcp.py` — MCP transport

**The app does not spawn the MCP server. It connects to one over HTTP.**

Playwright MCP runs as a standalone server with `--port`, and the `mcp`
SDK's `streamable_http_client` connects to it by URL. Verified: a full
harvest (navigate → consent → click → verify) ran over
`http://localhost:8931/mcp` with the same results as stdio.

This removes the entire problem class rather than working around it:

| | stdio (spawn) | HTTP (connect) |
|---|---|---|
| Node on PATH | app's problem | not the app's problem |
| WSL `/mnt/c/npx` trap | real | gone |
| Browser install | app's problem | server's problem |
| Docker | Node + browsers in the app image | separate service, `depends_on` |
| Config | command + args + env | one URL |
| Test isolation | must avoid spawning | nothing to avoid |

The application code becomes OS-agnostic: one setting, `MCP_URL`. In Docker
the server is a `docker-compose` service built from the official
`mcr.microsoft.com/playwright` image; locally a developer runs one command,
documented in AGENTS.md:

```bash
npx @playwright/mcp@latest --port 8931 --headless --isolated \
    --codegen python --browser chromium --caps testing
```

Every flag is load-bearing: `--codegen python` is the entire mechanism,
`--caps testing` adds the `browser_verify_*` tools, `--browser chromium`
because the default `chrome` channel is not installed, `--isolated` so
consent banners reappear on each run (otherwise the agent never learns to
dismiss them and the fresh `pytest` run trips over one).

> **Still a background thread.** HTTP removes the subprocess, not the
> async. `streamable_http_client` is async like the rest of the SDK, so the
> sync facade from the previous section stays exactly as designed and
> verified — only the transport inside it changes.

A convenience fallback that spawns the server when `MCP_URL` is unset is
possible later, but it is not the primary path and nothing should depend
on it.

```python
class MCPToolset(Protocol):
    def list_tools(self) -> list[McpTool]: ...
    def call_tool(self, name: str, arguments: dict) -> McpResult: ...
```

**Tool allowlist** — core plus `testing`:

```
browser_navigate  browser_click      browser_type       browser_fill_form
browser_select_option  browser_press_key  browser_wait_for
browser_snapshot  browser_find
browser_verify_element_visible  browser_verify_text_visible
browser_verify_value            browser_verify_list_visible
```

Three exclusions are deliberate and must not be relaxed:

- **`browser_run_code_unsafe`** is RCE-equivalent by Microsoft's own
  description.
- **`browser_evaluate`** ignores `--codegen python` and emits JavaScript.
- **`browser_generate_locator`** returns JavaScript locator syntax.

The allowlist is **validated against `list_tools()` at startup** and fails
loudly if a name is missing. With `@latest` rather than a pin (see below),
that check is what turns an upstream rename into a clear error instead of a
silently degraded agent.

MCP's raw `input_schema` passes straight through as the provider's tool
schema, after stripping `$schema` and `additionalProperties` — verified
accepted by Azure.

### Versioning: `@latest`, not a pin

The server is tracked at `@latest`. The app connects by URL and never names
a version, so the version lives wholly in whatever launches the server
(compose file, dev command).

The cost is real and worth stating: the tool surface moves. 0.0.83 exposes
25 tools by default, 30 with `--caps testing`, 50 with all capabilities,
and `--help` does not document the `testing` cap at all. The startup
allowlist check is the mitigation — it converts an upstream change from a
mysterious behavioural regression into an immediate, named failure.

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
MCP_URL              # e.g. http://localhost:8931/mcp
MCP_MAX_TURNS        # tool-iteration cap per step
```

That is the whole surface. Browser choice, headless, codegen language and
capabilities are all server-side launch flags, not application config —
which is precisely why the app stops caring what OS it runs on.

## Testing

| Layer | Approach |
|---|---|
| `mcp.py` | Fake `MCPToolset`. No server, no network, ever. |
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
- **A second browser, in its own container.** The MCP server needs Node
  Playwright's own chromium build, separate from the Python one. Over HTTP
  that weight lands in a sidecar image rather than the app image, but it is
  still ~300MB plus Node in the compose stack (M5).
- **An operational dependency.** The app now needs a reachable MCP server
  before Level 2 can run. A clear startup failure (connect + allowlist
  check) matters more than it would for an in-process library.
- **A fast-moving dependency.** Tracking `@latest` means the tool surface
  can shift under us — 25 / 30 / 50 tools depending on `--caps`, and
  `--help` does not even document `testing`. The startup allowlist check is
  the guard.
- **Non-determinism.** The agent may harvest a different-but-valid locator
  across runs. Replay proves each one works; it does not make them stable.

## Open questions

1. **Restoring MCP to the pre-step state on retry.** Currently out of
   scope, with the limitation documented instead. Worth revisiting: with an
   HTTP server, a retry could open a *fresh MCP session* and replay the
   validated prefix into it, which would make retries clean.
2. **Deduplicating `optional` statements across steps.** A consent click
   harvested into step 3 should not reappear in step 5.
3. **Per-step vs per-module conversations** if token cost proves too high.
4. Whether `Module` survives at all once `url` is advisory.
