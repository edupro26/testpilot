# Roadmap

What is planned next for the application. The current design is described in [APP_DESCRIPTION.md](./APP_DESCRIPTION.md).

## Planned

| # | Item | Description |
|---|---|---|
| 1 | Wait for elements before acting | Make the generated code wait for elements that appear late before acting on them. Playwright MCP settles after every action, but that wait is not in the emitted code, so pages that render content late (e.g. `https://appsmobileqms.nos.pt/WOO_MOB/Prelogin`) can pass during extraction and fail on replay or at run time. |
| 2 | Pipeline + CLI implementation | Split today's `main.py` into `pipeline.py` (orchestration) and `cli.py` (Typer app). Add CLI options, e.g. stop after the validated JSON (no script), choose the output folder, and override the LLM provider and its credentials at invocation time. |
| 3 | Retry loops with `MAX_RETRIES` | Replace the single retry with configurable retry loops: in the Extractor (an `ExtractorError` such as running out of turns currently aborts the run) and between the Extractor and Validator (today one retry after a rejection, then abort). |
| 4 | Input variables | Let a test case reference variables (e.g. login credentials) by name instead of writing values into the steps. Values are supplied at invocation time and the generated script reads them rather than hard-coding them. |
| 5 | Pre-conditions | Let a test case declare the state it starts from (e.g. a logged-in user, an item in the cart), and define how that state is established before the steps run. |
| 6 | Multiple markdown inputs | Accept several `.md` files in one invocation, producing one test script per input or a single bundled script. |
| 7 | Test execution + reporting | Run the generated scripts from the application and produce a test report, with options mirroring the main `pytest-playwright` flags (e.g. `--headed`, `--browser`, `--screenshot`) and an option to generate without executing. |
| 8 | Generic prompt input | Accept a free-form user prompt instead of a structured markdown test case; the agent analyses it and builds the structured test case itself. |
| 9 | Frontend | A client–server application: a frontend (client) talking to a server that runs the pipeline, replacing the single local CLI. |

## Carried over

Earlier plans and code reviews also raised these.

| # | Item | Description |
|---|---|---|
| 10 | Docker | Containerise the application. Playwright MCP needs Node and its own browser build, so it likely runs as a separate container next to the application. |
| 11 | Locale support | Support pages in more than one locale (e.g. en-US and pt-PT). The Playwright MCP locale is fixed per server, so this needs one locale per test case (one server per locale) or language-neutral locators. |
| 12 | Multi-line statements | Allow a collected statement to span several lines; collected code is currently split line by line. |
| 13 | Integration tests | An optional test suite exercising a live LLM and Playwright MCP server, on top of the offline suite. Also unit tests for `openai_chat.py` and the retrying conversation wrapper. |

## To evaluate

Not part of the roadmap: an analysis to carry out before deciding.

**Migrating the source code to TypeScript.** Possible benefits:

- Run Playwright MCP with TypeScript codegen.
- Possibly spawn Playwright MCP in-process and talk to it over stdio instead of HTTP.
- Integrate Playwright directly for test execution.
- Use Playwright's built-in reporting.
