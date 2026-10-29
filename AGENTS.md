# TestPilot

> **Audience**: LLM-driven agents

## Repository map

```
docs/                               # APP_DESCRIPTION.md (design), ROADMAP.md (next steps)
examples/                           # sample test-case markdown inputs, grouped by target site
mcp/                                # Playwright MCP server config (config.json)
output/                             # gitignored, per-run generated artifacts, mirrored per examples/ subfolder
prompts/                            # one template per pipeline stage
src/
├── extractor/                      # agent drives Playwright MCP, collects emitted code
├── generator/                      # LLM assembles the script around the validated statements
├── llm/                            # LLM provider abstraction: protocol, factory, provider/
├── model/                          # shared JSON-contract schemas (TestCase, StepStatement, ...)
├── structurer/                     # markdown -> structured JSON
├── validator/                      # browser.py (replay) + service.py (semantic check)
├── config.py                       # Settings + logging configuration
├── exceptions.py                   # PipelineError, per-stage errors, ConfigurationError
├── main.py                         # CLI entrypoint and pipeline wiring
└── prompt_loader.py                # load_prompt / render_prompt
test/                               # pytest suite mirroring src/
```

## Rules & Code conventions

1. **Language**: Python ≥ 3.13
2. **Package management**: ONLY use `uv`, NEVER `pip`
3. **Line length**: 88 characters maximum
4. **Imports**: Absolute imports, sorted by Ruff
5. **Type safety**: All functions require type hints
6. **Naming**: `snake_case` functions, `PascalCase` classes
7. **Docstrings**: Google-style for all public APIs
8. **Commits**: Never mention tools/AI
9. **Commit Type**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
10. **File hygiene**: Prefer editing existing files over creating new ones

## Dev workflow

```
uv sync --locked --dev               # install dependencies
uv run ruff check --fix .            # code lint
uv run ruff format .                 # code format
uv run pytest -q                     # run the test suite

uv run python -m src.main <path.md>
```

### Playwright MCP server (required to run the pipeline)

The Extractor drives a real browser through Playwright MCP. The app **connects**
to a running server over HTTP rather than spawning one, so it stays free of
any assumption about Node, `npx` resolution or browser installs.

Everything the server needs is in `mcp/config.json`, so one command starts
it correctly:

```
npx @playwright/mcp@latest --config ./mcp/config.json
```

One-off, to install the browser build the server needs (separate from the
Python one):

```
npx @playwright/mcp@latest install-browser chrome-for-testing
```

Point the app at it with `MCP_URL` (default `http://localhost:8931/mcp`).
Any CLI flag still overrides the file, which is handy for a second server:
`--config ./mcp/config.json --port 8936`.

#### What each config key is for

| Key | Why it matters |
|---|---|
| `codegen: "python"` | The whole mechanism. Each tool result reports the Python statement it ran, which is what the Extractor collects. Without it you get JavaScript. **It is a string, not an object** -- an object raises `TypeError: Cannot read properties of undefined (reading 'reset')` on the first navigation. |
| `capabilities: ["testing"]` | Adds the `browser_verify_*` assertion tools. Undocumented in `--help`, but required: without them a verification step has no assertion to collect. |
| `browser.contextOptions.locale` | Must match `BROWSER_LOCALE`. Sites translate by `Accept-Language`, so a mismatch means the agent proves a locator against one wording and the script meets another. |
| `browser.browserName: "chromium"` | The default `chrome` channel is usually not installed. |
| `browser.isolated: true` | A fresh in-memory profile per session, so consent banners reappear every run. With a persisted profile the agent never learns to dismiss them and the generated script trips over one. It is also what makes the retry reset work. |
| `server.port` | Where the app connects. |
| `outputDir` | Or the server writes `.playwright-mcp/` into the current working directory. |
