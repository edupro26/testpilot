# Roadmap

What is planned next for the application. The current design is described in [APP_DESCRIPTION.md](./APP_DESCRIPTION.md).

## Planned

| # | Item | Description |
|---|---|---|
| 1 | Pipeline + CLI implementation | Split today's `main.ts` into `pipeline.ts` (orchestration) and `cli.ts` (commander program). Add CLI options, e.g. stop after the validated JSON (no script), choose the output folder, and override the LLM provider and its credentials at invocation time. |
| 2 | Retry loops with `MAX_RETRIES` | Retry Extractor failures too: an `ExtractorError` such as running out of turns currently aborts the run, while validation failures already re-extract the failing step within a run-wide `MAX_RETRIES` of 5. Also make that budget configurable rather than a constant. |
| 3 | Input variables | Let a test case reference variables (e.g. login credentials) by name instead of writing values into the steps. Values are supplied at invocation time and the generated script reads them rather than hard-coding them. |
| 4 | Pre-conditions | Let a test case declare the state it starts from (e.g. a logged-in user, an item in the cart), and define how that state is established before the steps run. |
| 5 | Multiple markdown inputs | Accept several `.md` files in one invocation, producing one test script per input or a single bundled script. |
| 6 | Test execution + reporting | Run the generated scripts from the application and produce a test report, with options mirroring the main `npx playwright test` flags (e.g. `--headed`, `--project`, `--reporter`) and an option to generate without executing. |
| 7 | Generic prompt input | Accept a free-form user prompt instead of a structured markdown test case; the agent analyses it and builds the structured test case itself. |
| 8 | Frontend | A client–server application: a frontend (client) talking to a server that runs the pipeline, replacing the single local CLI. |

## Carried over

Earlier plans and code reviews also raised these.

| # | Item | Description |
|---|---|---|
| 9 | Docker | Containerise the application. Playwright MCP runs in-process and shares the application's browser build, so one image (e.g. based on the official Playwright image) can hold both. |
| 10 | Locale support | Support pages in more than one locale (e.g. en-US and pt-PT). The Playwright MCP locale is fixed per server, so this needs one locale per test case (one server per locale) or language-neutral locators. |
| 11 | Multi-line statements | Allow a collected statement to span several lines; collected code is currently split line by line. |
| 12 | Integration tests | An optional test suite exercising a live LLM and Playwright MCP server, on top of the offline suite. Also unit tests for the retrying conversation wrapper. |
