# TestPilot

TestPilot is a GenAI enabler for quick test script generation and automation. It is an LLM-powered application that, based on a specification of a test case (.md), generates a Playwright (TypeScript) test script, which can then be executed to receive a test report. It is currently in alpha: the full pipeline works end to end, and the next features are tracked in the roadmap.

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
- `Playwright MCP`: A Playwright MCP server running inside the application,
    reached over an in-memory MCP transport. It owns the agent's browser,
    which is a workspace: it also holds failed attempts and exploratory
    detours
- `Validation Browser`: A separate, clean Playwright browser that runs only
    accepted code. Its state is exactly what the generated script will
    produce
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
                            "code": "await page.goto('http://automationexercise.com');",
                            "reason": "Navigates the page to the requested URL ..."
                        },
                        {
                            "code": "await page.getByRole('button', { name: 'Consent' }).click();",
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
    complete Playwright Test (`@playwright/test`) spec (header comment,
    import, test title, one comment per step) around the validated
    statements and a fixed locale setting. The result must parse and must
    contain every statement and the locale setting unchanged and in order;
    otherwise the run fails. There is no retry, and the validated JSON is
    already on disk

**Output**: The executable test script file

```typescript
/**
 * Login with incorrect credentials.
 *
 * Checks that a wrong email and password show an error message.
 */

import { expect, test } from '@playwright/test';

test.use({ locale: 'en-US' });

/** Verify that incorrect login credentials show an error message. */
test('Login user with incorrect credentials', async ({ page }) => {
  // Launch browser and navigate to url 'http://automationexercise.com'
  await page.goto('http://automationexercise.com');
  await page.getByRole('button', { name: 'Consent' }).click();

  // Verify that the home page is visible successfully
  await expect(page.getByRole('heading', { name: 'AutomationExercise' })).toBeVisible();
  ...
});
```

## Requirements

### Functional
1. Accept a markdown test-case specification file as CLI input.
2. The Structurer converts the markdown into the structured test case via one LLM call.
3. For each execution step, in order, the Extractor performs the step in a live browser through Playwright MCP, using only an allowlisted set of tools, and reports the code lines that belong to the step. Only lines emitted by a code-generating tool during that step are accepted.
4. The Validator replays each step's code in the Validation Browser, then judges via an LLM call whether it accomplishes the step, before the step is accepted.
5. On a rejection, both browsers are reset and the step is retried once with the rejection as feedback; a second rejection aborts the run with a `ValidatorError`. An Extractor failure (no completion within `MCP_MAX_TURNS`, a malformed report, or a line Playwright MCP never ran) aborts the run with an `ExtractorError`.
6. Popups (cookie-consent banners, newsletters, surveys) are dismissed in the step that makes them appear, as ordinary validated statements. There is no site-specific or injected overlay handling.
7. The Generator turns the validated test case into a single executable Playwright Test (TypeScript) spec, using the `page` fixture, with every validated statement copied unchanged. A script that drops or alters a statement or does not parse aborts the run with a `GeneratorError`.
8. The CLI runs the full pipeline as a single command: `testpilot <path.md>` (after `npm link`; `npm run testpilot -- <path.md>` without it). Playwright is the only target framework.
9. The pipeline writes the validated JSON and the generated script under `output/<input's parent folder name>/`, both named after the input file (e.g. `examples/automation/test_x.md` -> `output/automation/test_x.json` and `output/automation/test_x.spec.ts`). The JSON is written before generation, so a generation failure never loses it.
10. The LLM provider is selectable via `LLM_PROVIDER`: `azure_openai` (the primary target) or `mock` (offline development and testing).
11. All three browsers (Playwright MCP's, the Validation Browser and the generated script's) use the same locale, so locators found by their text match at run time.

### Non-functional
1. TypeScript, run directly by Node.js ≥24 (no build step), `npm`-only dependency management.
2. `strict` TypeScript with every function's return type declared; JSON contracts are zod schemas.
3. Code passes `tsc`, the repo's ESLint configuration (type-aware, TSDoc on exported APIs) and Prettier (print width 88) with zero errors.
4. Secrets are sourced only from environment variables/`.env`, never hardcoded; `.env` stays gitignored.
5. No out-of-band authentication: a page behind a login is reachable only if the test case's own steps log in.
6. Generated scripts must pass `npx playwright test` against the live site they were generated from, for the demoed examples.
7. Each stage is unit-testable offline via the mock LLM provider and a fake MCP server, with no live network or LLM calls.
8. Logging goes through the application logger (not ad hoc `console` calls), level controlled by `LOG_LEVEL`, with clear per-stage log lines.
9. Single-user local CLI tool; no persistence layer or multi-tenant concerns in scope.
10. The application runs Playwright MCP in-process, and fails at startup with a clear error if it does not offer every allowlisted tool.

## Design Decisions

### Collect, never write

The Extractor's LLM does not author Playwright code. It drives the browser, and Playwright MCP reports the code each successful action ran, which is the same generator Playwright's own `codegen` uses. The agent's only job at the end of a step is to *select* which of those lines belong to it, leaving out failed attempts and detours. A line that was never emitted is rejected, which is also the safety boundary around running code in the Validation Browser.

Only tools whose emitted code is a self-contained test line are collectable (`COLLECTABLE_TOOLS` in `src/extractor/mcp/constants.ts`): navigation (including back), click, hover, drag, type, fill, select, key presses, waits, and the `browser_verify_*` assertions. Other tools (find, snapshot, evaluate, screenshots, resizing, file uploads, dialogs) still help the agent explore, but their code is never collected: they either emit no code, do not act on the page, or emit code that depends on a variable from an earlier line. Narrating comment lines in a tool's code (such as `// Press Tab`) are not statements.

TypeScript is the one codegen language every Playwright MCP tool honours: tools outside Playwright's code generator emit hard-coded TypeScript whatever `codegen` says. The application, the Validation Browser and the generated script are all TypeScript, so the language a tool emits is never a reason to withhold its code.

Two traits of that generator show up in the scripts:
- It prefers test-id attributes (`data-testid`, `data-test-id`, `data-test`) when the element has one.
- It shortens long text (over 30 characters) to a word-bounded prefix, e.g. `getByText('Your email or password is')`. The full text was checked against the live page during extraction, so the Validator accepts the prefix.

### Two browsers

The Playwright MCP browser is the agent's workspace and holds whatever the agent did while exploring. Playwright MCP also waits briefly after every action, and that wait is not in the emitted code. Code that works there is therefore not yet known to work on its own.

The Validation Browser is the contract: plain Playwright running nothing but accepted code, each statement compiled into a function of `page` and `expect` only. Replay is cumulative (one browser for the whole test case, each step's code added as it is accepted), so it reproduces exactly the state the generated script will see.

### Retry and reset

Before a retry both browsers are reset, so the agent sees the page as the script would, including a consent banner it had already dismissed. The Validation Browser is restarted and re-runs the accepted code; Playwright MCP gets a fresh session (a new in-process server and a newly launched browser, so an empty profile) and is sent to the URL the Validation Browser ended on. Only the URL carries over to Playwright MCP, so the agent is told to redo any setup the step depends on (a login, a cart) without reporting it.

### The Generator only assembles

Every statement was proven against a live browser, and letting an LLM rewrite them would discard that proof. The LLM writes everything around them (comments, the import, the test title, step comments), and a deterministic check rejects the script if any validated line or the locale setting is missing, changed or out of order.

### Locale

Sites translate their text by the browser's `Accept-Language`, and most locators are text-based. `BROWSER_LOCALE` sets the locale of all three browsers: it is used for the context handed to Playwright MCP and for the Validation Browser's context, and pinned into the generated script by `test.use({ locale })`.

### Playwright MCP version

`@playwright/mcp` is pinned in `package.json`, and an `overrides` entry makes it use the same Playwright as `@playwright/test`, so everything shares one install and one browser build. The tool surface changes between releases, so the application checks at startup that every allowlisted tool is offered, turning an upstream change into an immediate, named failure. `browser_run_code_unsafe` (arbitrary code in the server process) and `browser_close` (would end the session the pipeline owns) are never exposed.

## Playwright MCP Server

The application runs Playwright MCP itself (`createConnection` from `@playwright/mcp`, connected over an in-memory transport); there is no server to start. Each session gets a freshly launched headless Chromium, whose context (locale from `BROWSER_LOCALE`, see *Locale*) is handed to the server: a fresh profile per session, so consent banners reappear every run and the retry reset works. The application closes that browser with the session, since Playwright MCP leaves a browser it launched itself running when its server closes.

The server's configuration is built in code (`mcpConfig()` in `src/extractor/mcp/server.ts`):

| Configuration key | Why it matters |
|---|---|
| `codegen: "typescript"` | Makes every tool result report the TypeScript statement it ran, which is what the Extractor collects. |
| `capabilities: ["testing"]` | Adds the `browser_verify_*` assertion tools; without them a verification step has nothing to collect. |
| `browser.isolated: false` | Use the context the session is given rather than open another one. |
| `outputDir` | Otherwise the server writes `.playwright-mcp/` into the working directory. |

## Known Limitations

- **Waits are only collected when the agent asks for them.** Playwright MCP settles after every action, and that implicit wait is not in the emitted code. An explicit `browser_wait_for` is collectable, but pages that render content late can still pass in Playwright MCP and fail on replay if the agent does not use it (see [ROADMAP.md](./ROADMAP.md)).
- **One retry, and only for rejections.** A step gets a single retry after a Validator rejection; an Extractor failure aborts the run immediately.
- **Single-line statements.** Collected code is split line by line, so a statement spanning several lines would be rejected.
- **One locale per run.** The Playwright MCP locale is fixed when its session starts, so a run covers one locale.
- **Cost and latency.** Each step is its own agent conversation of several tool calls, plus a Validator call.
- **Non-determinism.** Replay proves each statement works; it does not guarantee the same locator is chosen on every run.

## Repository Structure

```
docs/
├── images/                         # images for documentation
├── APP_DESCRIPTION.md              # this document
└── ROADMAP.md                      # what is planned next
examples/                           # sample test-case markdown inputs, grouped by
|                                     target site (e.g. examples/automation/)
output/                             # gitignored, per-run generated artifacts
|                                     (JSON + spec), mirroring examples/'s
|                                     per-site subfolders
prompts/                            # one template per LLM call
├── structurer.md
├── extractor.md
├── validator.md
└── generator.md
src/
├── extractor/
|   ├── mcp/
|   |   ├── constants.ts            # timeouts, allowed and collectable tools,
|   |   |                             emitted-code pattern
|   |   └── server.ts               # PlaywrightMCP: in-process server and
|   |                                 in-memory client; mcpConfig()
|   ├── agent.ts                    # StepAgent: per-step tool-calling loop,
|   |                                 collects the reported statements
|   ├── service.ts                  # Extractor: runs one step
|   └── utils.ts                    # prompt context, step rebuilding, checks
├── generator/
|   └── service.ts                  # Generator: LLM assembly + verbatim check
├── llm/                            # LLM provider abstraction
|   ├── protocol.ts                 # LLMProvider interface (completion and
|   |                                 tool-calling conversation)
|   ├── factory.ts                  # getLlmProvider(settings)
|   ├── retry.ts                    # rate-limit retry wrapper applied to every
|   |                                 provider
|   └── provider/                   # concrete LLMProvider implementations
|       ├── mock.ts
|       ├── azure-openai.ts
|       └── openai-chat.ts          # Chat Completions tool-calling conversation
├── model/                          # shared JSON-contract schemas
|   └── test-case.ts                # TestCase, Module, ExecutionStep, StepStatement
├── structurer/
|   └── service.ts                  # Structurer: markdown -> structured JSON
├── validator/
|   ├── browser.ts                  # ValidationBrowser: replays accepted code
|   └── service.ts                  # Validator: replay + semantic check
├── config.ts                       # zod Settings + configureLogging()
├── exceptions.ts                   # PipelineError + per-stage subclasses
├── logger.ts                       # levelled, coloured stderr logger
├── main.ts                         # CLI entrypoint and pipeline wiring
└── prompt-loader.ts                # loadPrompt / renderPrompt
test/                               # Vitest suite mirroring src/
playwright.config.ts                # runs the generated specs in output/
```
