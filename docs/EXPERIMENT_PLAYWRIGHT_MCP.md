# Experiment — Playwright MCP as the Level 2 engine

> Branch: `feat/experiment-playwright-mcp`. Investigation notes, not an
> accepted design. Spike run 2026-10-01 against `@playwright/mcp@0.0.83`.

## The idea

Instead of the Extractor picking *selectors* out of a page dump and the
Validator checking them, give the LLM the **Playwright MCP** toolset and let
it drive a real browser step by step. Level 2's output stops being
`identifier_type`/`identifier_tracking` and becomes **validated Playwright
Python statements per step**. The Generator then only assembles a script.

## What the spike established

All of the following was executed, not read in docs.

### 1. `--codegen python` emits portable Python — the key enabler

Every successful tool result carries a `### Ran Playwright code` block. With
`--codegen python` (the flag accepts `typescript|python|java|csharp|none`,
default `typescript`) that block is **idiomatic Python sync API**, not
JS and not opaque snapshot refs:

```python
page.goto("http://automationexercise.com")
page.get_by_role("button", name="Consent").click()
page.get_by_role("link", name=" Signup / Login").click()
page.locator("form").filter(has_text="Login").get_by_placeholder("Email Address").fill("wrong_user_12345@example.com")
page.get_by_role("textbox", name="Password").fill("WrongPassword123")
page.get_by_role("button", name="Login").click()
```

Snapshot `ref=e23` handles are an *input-side* addressing mechanism only;
they never leak into the emitted code.

### 2. The emitted *action* code runs verbatim as a real test

Pasted unchanged into a `pytest-playwright` test, with one `expect(...)`
assertion appended by hand, it **passed in 3.62s** against the live site.

Two honest caveats on that result:

- **Only actions are harvested.** Steps 2, 4 and 7 of the spec are
  verifications — nearly half the test — and MCP emits no code for them.
  The `expect(...)` line was written by hand, not harvested. See
  §6 for the workaround.
- **No LLM drove this particular run.** The tool calls were scripted, with
  refs resolved by regex. A separate live run (§7) closed that gap.

### 3. MCP solves the duplicate-selector problem by itself

`automationexercise.com/login` has two "Email Address" textboxes (login and
signup forms). MCP disambiguated without being asked:

```python
page.locator("form").filter(has_text="Login").get_by_placeholder("Email Address")
```

Even its *failures* hand back the fix — a strict-mode violation names the
disambiguating locator for every candidate:

```
strict mode violation: locator('form') resolved to 3 elements:
    1) <form method="POST" action="/login">…</form> aka locator('form').filter({ hasText: 'Login' })
```

### 4. Errors are rich enough to self-heal

Clicking through the cookie banner failed with a call log naming the
blocker outright:

```
TimeoutError: Timeout 5000ms exceeded.
  - waiting for getByRole('link', { name: /Signup \/ Login/ })
    - <div class="fc-dialog-overlay"></div> from <div class="fc-consent-root">…</div> subtree intercepts pointer events
```

An agent reading that knows to dismiss consent first. This replaces the
deterministic `remove_overlay_elements.js` injection (functional req 6)
with the consent click becoming an ordinary, validated step.

### 5. Context cost is manageable *only if full snapshots are avoided*

| Call | Size |
|---|---|
| `browser_snapshot {}` (homepage, 908 nodes) | 41KB inlined — **~10k tokens** |
| `browser_snapshot {}` (login page) | 4.4KB inlined |
| `browser_snapshot {"depth": 3}` | 1.2KB |
| `browser_find {"text": "..."}` | 0.4–1.9KB |
| `browser_navigate` / `browser_click` result | 0.3–0.4KB |

Two things matter here:

- **An explicit `browser_snapshot` inlines everything**, however big. Only
  `browser_navigate` spills its snapshot to a file in `--output-dir` and
  links it. So full snapshots must be discouraged in the prompt;
  `browser_find` and `depth`-limited snapshots are the workhorses.
- **Action results carry no page state** (0.3–0.4KB, just the code and the
  URL/title). After a click the model is blind until it asks. The loop has
  to make that explicit rather than assume the model sees the new page.

### 6. The `testing` capability emits whole assertions

**Correction to an earlier version of this document**, which claimed
`browser_generate_locator` and `browser_verify_*` do not exist in 0.0.83.
They do. `--help` lists only `vision, pdf, devtools` under `--caps`, but
**`testing` is accepted and undocumented**:

| `--caps` | tools |
|---|---|
| *(none)* | 25 |
| `testing` | 30 — adds `browser_generate_locator`, `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_value`, `browser_verify_list_visible` |
| `vision,pdf,devtools` | 45 |
| all four | 50 |

The `browser_verify_*` tools execute the assertion against the live page
**and emit it as Python**:

```
browser_verify_element_visible {"role": "heading", "accessibleName": "Login to your account"}
→ expect(page.get_by_role("heading", name="Login to your account")).to_be_visible()
```

So verification steps harvest exactly like action steps — no composed
`expect(...)` wrapper, and no truncation problem. A failing verification
returns `isError=True` with a terse reason (`Text not found`), the same
recoverable signal a failed click gives.

`browser_generate_locator` is the exception: it returns **JavaScript**
syntax (`getByRole('heading', { name: '...' })`) regardless of
`--codegen python`, so it stays unused. `browser_evaluate` leaks JavaScript
the same way. Both must stay off the allowlist.

## How to expose MCP to the LLM provider

**Not** via Anthropic's MCP connector or OpenAI's hosted MCP tool: both
require a **publicly reachable HTTPS URL** and cannot reach a local stdio
server or localhost. They are also Anthropic/OpenAI-specific, and PLAN.md
req 9 makes `azure_openai` the primary target.

Instead, run the MCP client **in-process** and own the agent loop:

1. `mcp` Python SDK → `stdio_client(StdioServerParameters(...))` →
   `ClientSession`. Verified working against 0.0.83.
2. `session.list_tools()` → pass each tool's `input_schema` straight
   through as the provider's function/tool schema.
3. Loop: model returns tool calls → `session.call_tool()` → feed results
   back → repeat until the model reports the step done.

This is provider-agnostic and needs no public network exposure.

### Consequence for `LLMProvider`

The protocol today is `complete(system_prompt, user_prompt, json_mode) -> str`.
It needs a second, tool-calling method returning structured tool calls, implemented
per provider (Anthropic / OpenAI / Azure OpenAI) and scriptable in `MockProvider`
so the suite still runs offline (non-functional req 7).

## Tool surface (25 core tools, 30 with `--caps testing`)

```
browser_navigate  browser_navigate_back  browser_click      browser_type
browser_fill_form browser_select_option  browser_hover      browser_drag
browser_drop      browser_press_key      browser_file_upload
browser_snapshot  browser_find           browser_take_screenshot
browser_wait_for  browser_evaluate       browser_handle_dialog
browser_console_messages  browser_network_requests  browser_network_request
browser_tabs      browser_resize         browser_emulate_media
browser_close     browser_run_code_unsafe
```

Notes:

- The five `testing`-capability tools are listed in §6, not here.
- `--help` under-reports `--caps`: it documents `vision, pdf, devtools`
  but `testing` works. Do not trust `--help` as the capability list.
- **Never expose `browser_run_code_unsafe`** — it is RCE-equivalent by
  Microsoft's own description. Allowlist the ~10 tools actually needed.

## Environment traps found

- **Node is not on the default WSL PATH.** `npx` resolves to the *Windows*
  binary under `/mnt/c` (11.13.0); the Linux one (nvm, v24.18.0, npx 11.18.0)
  lives at `~/.nvm/versions/node/v24.18.0/bin`. This trap is why the design
  connects to MCP over HTTP (`--port`) instead of spawning it — verified
  working via the SDK's `streamable_http_client`, which removes the
  question of which `npx` the app would have found.
- **The MCP server needs its own browser.** It wants Node Playwright's
  chromium build (1247); the Python side has 1234/1243. Fix:
  `npx @playwright/mcp@0.0.83 install-browser chrome-for-testing`
  (~190MB + ~119MB headless shell). Two Playwright installs, two browser
  binaries — relevant for the future Docker image.
- Default browser is the `chrome` **channel**, which is not installed.
  Pass `--browser chromium`.
- The tool surface moves fast and varies by `--caps` (25 / 30 / 50).
  Whatever version policy is chosen, validate the allowlist against
  `list_tools()` at startup rather than assuming a tool is present.
- Use `--isolated` so every run starts from a clean profile. With a
  persistent profile, consent accepted once would never reappear, the
  agent would never emit consent handling, and the fresh `pytest` run
  would then hit the banner.
- Set `--output-dir`; otherwise the server writes `.playwright-mcp/` into
  the current working directory.
- The `mcp` SDK is **async**. Driving the sync Playwright API from inside
  that event loop raises "Sync API inside the asyncio loop" — the
  validator must use async Playwright or run in a separate thread.

## Design positions

**Harvest, never free-write.** The LLM must not author action code. It
drives MCP, then *selects* which of the harvested statements belong to the
step. Exploratory detours — a wrong click, a `navigate_back`, a hover done
only to get a locator — all emit code too, so the transcript is not the
answer. Letting the model write the code loses the verbatim property that
makes this whole approach worth doing.

**Validate by fresh-context replay.** Re-running a step against MCP's live
page double-executes it (double click, double submit). Instead, replay the
selected statements for steps `0..i` in a *fresh* Python Playwright
context — literally the draft test, matching pytest's fresh-context model
(non-functional req 6). The 3.62s passing run above *was* this validator.

This is not optional polish: MCP waits 500ms after every action
(`--timeout-settle`) and that wait is **not** in the emitted code. Replay
is the only thing that proves the harvested statements stand on their own.
Cost: the prefix re-runs once per step.

**Mark best-effort steps `optional`.** The consent click only exists
because the banner blocked step 3, so it lands inside that step's code. If
the banner doesn't appear on a later run, a mandatory click burns
pytest's full timeout before failing — which is exactly why the
hand-written sample wraps it in `try/except`. The per-step contract needs
an `optional` flag the Generator turns into that guard.

**Docker cost, accepted.** This adds Node plus a second ~300MB browser
install to any future image (see traps below). That is a real cost of the
approach, not an open question.

**Validator keeps a narrowed LLM call.** Deterministic replay already
answers "does this code run". The LLM call survives only to answer "did
this actually verify what the step asked?" — the semantic question replay
cannot reach. It stays a distinct stage rather than folding into the
extraction loop, so the two roles stay separable.

## Still open

1. Per-step conversation vs one per module, and the tool-iteration cap
   (the live run took 6 turns for one step).
2. Assertion strength, given the text truncation noted in §6.
3. Leading-space accessible names (`name=" Signup / Login"`) come through
   verbatim. Harmless here, but worth watching.
4. Whether `optional` statements should be deduplicated across steps — a
   consent click harvested into step 3 shouldn't reappear in step 5.

## Reference — reproducing the spike

Scripts live in the session scratchpad, not the repo. Minimal form:

```python
SERVER = StdioServerParameters(
    command=f"{NODE_BIN}/npx",
    args=["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated",
          "--codegen", "python", "--browser", "chromium", "--output-dir", OUT],
    env={**os.environ, "PATH": f"{NODE_BIN}:{os.environ['PATH']}"},
)
```

`uv run --with mcp python <script>.py`. Note the SDK uses snake_case
(`server_info`, `input_schema`, `is_error`), not the camelCase in the docs.
