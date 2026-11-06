# Roadmap

What is planned next for the application. The current design is described in [APP_DESCRIPTION.md](./APP_DESCRIPTION.md).

## Priority: Copilot agent integration with skills

Comes before every other item. The goal is to let an agent such as GitHub Copilot in VS Code drive testpilot from inside a developer's own webapp project: testpilot is installed once per machine, set up once per project, and the agent learns how to use it from skills. The three tasks are worked on in any order.

| # | Task | Description |
|---|---|---|
| A | Installation and project setup | Go from `git clone` to a `testpilot` command on the PATH, and set a project up with `testpilot init`. Detailed below. |
| B | CLI commands | Design and build every command and flag the agent needs. Detailed below. |
| C | Skills | Write the skill that teaches an agent how to use testpilot, installed by `testpilot init --skills`. Detailed below. |

### A. Installation and project setup

**Once per machine**, inside the testpilot clone:

```bash
git clone https://github.com/edupro26/testpilot.git
cd testpilot
npm ci && npm link
```

`npm ci` installs the dependencies, and a `postinstall` script (`playwright install chromium`) downloads the Chromium build testpilot's own Playwright uses; it is a no-op when that build is already there. `npm link` puts the `testpilot` command on the PATH.

**Once per project**, inside the webapp project:

```bash
npm init playwright@latest            # only if the project has no Playwright yet
testpilot init
```

Generated tests run with the project's own Playwright and `playwright.config.*`, so its browsers, headed mode, reporters, screenshots and results folder all apply. Testpilot keeps its own Playwright only for the browsers it drives while generating (Playwright MCP and validation). Each Playwright version uses its own Chromium build, stored side by side in the shared Playwright cache, so the two installs never replace each other's browser.

**`testpilot doctor`** checks the setup and, for every failure, prints the exact command that fixes it:

- Node.js ≥ 24
- testpilot's Chromium build is installed (it can be removed by Playwright's cleanup if the clone is moved or deleted)
- the project has `@playwright/test` and a `playwright.config.*`, warning when its Playwright is older than testpilot's (the code Playwright MCP emits follows testpilot's version)
- the LLM settings are present, API key included

**`testpilot init`** runs `doctor` first and stops on a failure. It then reads the project's `testDir` and creates:

```
.testpilot/
    logs/                       # one log per generate run
    tests/                      # the validated JSON test case of each run
    .gitignore                  # ignores logs/, tests/ and .playwright-mcp/
    config.json                 # testpilot's settings, API keys excluded
```

`init` does not create `.playwright-mcp/`: Playwright MCP creates it inside `.testpilot/` the first time it writes output.

Re-running `init` is safe: it never overwrites an existing config. Installing the skills (task C) is added to it later.

#### Settings

Every setting except API keys lives in `.testpilot/config.json`. Test execution settings (browsers, headed mode, reporters, screenshots, results folder) stay in the project's `playwright.config.*`.

```json
{
    "llmProvider": "azure_openai",
    "azureOpenAI": {
        "endpoint": "https://llm-cm-lab.openai.azure.com/",
        "modelName": "gpt-5.5",
        "deploymentName": "gpt-5.5",
        "apiVersion": "2025-04-01-preview"
    },
    "scriptsDir": "tests/testpilot",
    "maxTurns": 15,
    "locale": "en-US",
    "logLevel": "info"
}
```

`scriptsDir` defaults to `<testDir>/testpilot/`, so Playwright picks the generated specs up. `llmProvider` is `azure_openai` or `mock`.

Any setting can be overridden by an environment variable carrying the `TESTPILOT_` prefix, so variables the webapp keeps for itself (e.g. its own `AZURE_OPENAI_API_KEY`) are never picked up by accident. The API key is only ever read from the environment.

| `config.json` | Environment variable |
|---|---|
| `llmProvider` | `TESTPILOT_LLM_PROVIDER` |
| `azureOpenAI.endpoint` | `TESTPILOT_AZURE_OPENAI_ENDPOINT` |
| `azureOpenAI.modelName` | `TESTPILOT_AZURE_MODEL_NAME` |
| `azureOpenAI.deploymentName` | `TESTPILOT_AZURE_DEPLOYMENT_NAME` |
| `azureOpenAI.apiVersion` | `TESTPILOT_OPENAI_API_VERSION` |
| (none) | `TESTPILOT_AZURE_OPENAI_API_KEY` |
| `scriptsDir` | `TESTPILOT_SCRIPTS_DIR` |
| `maxTurns` | `TESTPILOT_MAX_TURNS` |
| `locale` | `TESTPILOT_LOCALE` |
| `logLevel` | `TESTPILOT_LOG_LEVEL` |

Precedence, weakest first: defaults, `config.json`, the project's `.env`, the project's `.env.local`, the shell environment, command flags. Testpilot only reads `.env` and `.env.local`; it writes to a dotenv file only when asked to (`config set-azure-openai`, task B), and then touches only its own `TESTPILOT_` lines. A developer who wants the same key in every project exports it in their shell profile.

Out of scope for now: publishing testpilot to a package registry. That needs a build step (Node does not strip types from `.ts` files inside `node_modules/`), and is planned later.

### B. CLI commands

Today's `main.ts` is split in two: `src/runtime/pipeline.ts` (orchestration) and `src/cli/` (`cli.ts`, the commander program, plus one file per command). `testpilot config` has only the `list` and `set-azure-openai` subcommands; other settings are edited by hand in `config.json`.

| Command | What it does | When |
|---|---|---|
| `testpilot --help`, `testpilot help <command>`, `testpilot <command> --help` | Usage, from commander | Now |
| `testpilot --version` | The installed version | Now |
| `testpilot doctor` | Checks the setup (task A) and prints the fix for each failure | Now |
| `testpilot init` | Sets the project up (task A) | Now |
| `testpilot init --skills=<agents>` | Also installs the skills into the project, e.g. `--skills=copilot,claude` | With task C |
| `testpilot init --skills=<agents> -g` | Installs the skills into the user's agent folders (e.g. `~/.copilot/skills/`) for every project | Later |
| `testpilot config list` | Every effective setting, the source it came from, API keys masked | Now |
| `testpilot config set-azure-openai` | Writes the Azure OpenAI settings (below) | Now |
| `testpilot generate <path.md>` | Generates the script for a test case (below) | Now |
| `testpilot run <path.spec.ts>` | Runs a generated script with the project's Playwright; see Planned item 1 | Later |
| `testpilot update` | `git pull && npm ci` in the clone, then re-checks testpilot's Chromium | Later |
| `testpilot logs [run]` | Lists recent generate runs, or prints one run's log (the latest by default) | Later |

**`config set-azure-openai`**

```bash
testpilot config set-azure-openai \
    --endpoint=<endpoint> \
    --model-name=<model_name> \
    --deployment-name=<deployment_name> \
    --api-version=<api_version> \
    --prompt-api-key \
    --save=dotenv[:path]
```

- The given values are written to `.testpilot/config.json`, and `llmProvider` is set to `azure_openai`.
- Without `--prompt-api-key`, the developer sets `TESTPILOT_AZURE_OPENAI_API_KEY` themselves.
- `--prompt-api-key` asks for the key with hidden input and writes only `TESTPILOT_AZURE_OPENAI_API_KEY` to a dotenv file: the `--save` path when given, `.env.local` otherwise. The key never goes to `config.json`, and it is never passed as a flag, so it stays out of shell history and agent transcripts.
- `--save=dotenv[:path]` also writes the other values as `TESTPILOT_` variables to that file (default `.env.local`).
- Writing a dotenv file adds or updates testpilot's own lines and keeps everything else. Keeping that file out of git is the developer's responsibility.

**`generate`**

```bash
testpilot generate <path.md> \
    --headed \
    --out=<dir> \
    --max-turns=<n> \
    --locale=<locale> \
    --log-level=<level> \
    --json
```

- `--headed` shows the browser the agent drives.
- `--out`, `--max-turns`, `--locale` and `--log-level` override `scriptsDir`, `maxTurns`, `locale` and `logLevel` for this run.
- `--json` prints a machine-readable result on stdout: status, spec path, JSON test case path, log path, and on failure the error code, failing stage, failing step and a hint (see task C).
- The validated JSON goes to `.testpilot/tests/`, the log to `.testpilot/logs/`, the spec to the scripts folder.

**Built for agents.** Every command:

- never prompts unless it runs in an interactive terminal, so an agent never hangs on a question;
- exits with `0` on success, `1` when the test case fails to generate, `2` on a setup or config error;
- writes progress to stderr and results to stdout, and always prints the log path;
- reports progress steadily during long runs (`generate` takes minutes), so it never looks stuck.

### C. Skills

One skill, `testpilot`, in the [Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) format (a `SKILL.md` with a name and description, plus reference files the agent reads only when it needs them). Copilot and Claude read the same format, so the same files are copied for every agent; only the destination differs.

| `--skills=` | Project (`init --skills`) | User (`init --skills -g`) |
|---|---|---|
| `copilot` | `.github/skills/testpilot/` | `~/.copilot/skills/testpilot/` |
| `claude` | `.claude/skills/testpilot/` | `~/.claude/skills/testpilot/` |

The skill's source lives in the testpilot repo:

```
skills/testpilot/
    SKILL.md                         # when to use it, the usual flow, hard rules
    references/
        commands.md                  # what each command is for and when to use it
        configuration.md             # config.json, TESTPILOT_ variables, precedence, LLM setup
        test-case-format.md          # the markdown testpilot expects, with a template
        errors.md                    # every error code: cause and fix
```

What the agent must be able to do:

- **Know the commands.** `commands.md` explains what each command is for and when to use it; for exact flags it points to `testpilot <command> --help`, so the skill does not drift from the CLI.
- **Help with LLM configuration.** The agent runs `testpilot config list` to see what is missing and `testpilot config set-azure-openai` with the values that are not secret. It never asks for, reads or writes the API key: it tells the developer to run `testpilot config set-azure-openai --prompt-api-key` in their own terminal.
- **Write or check a test case.** Whether the developer already has a markdown test case or asks the agent to write one, the agent follows `test-case-format.md`.
- **Generate a script.** The agent runs `testpilot doctor` when unsure of the setup, then `testpilot generate <path.md> --json`, waits for it to finish (it takes minutes), and reports the spec path.
- **Explain failures.** From the `--json` result the agent tells the developer what failed, at which step, and what they can do about it, using `errors.md`.

`doctor` warns when an installed skill does not match the installed testpilot version, and re-running `init --skills` updates it.

Two prerequisites, part of this task:

1. **A written test-case format.** Today the format (a title, the list of URLs, the numbered steps) exists only in `examples/` and the Structurer prompt. `test-case-format.md` describes it: what is required and optional, how to phrase action and verification steps, and a template.
2. **Actionable errors.** Today a failure is one of six error types (`ConfigurationError`, `StructurerError`, `McpError`, `ExtractorError`, `ValidatorError`, `GeneratorError`) with a free-text message. Each failure gets a stable error code, and `generate --json` reports it with the failing stage, the failing step and a hint. `errors.md` maps every code to its cause and fix, e.g. a missing API key (run `config set-azure-openai --prompt-api-key`), the agent running out of turns on a step (split the step or raise `maxTurns`), a missing Chromium build (run `testpilot doctor`).

## Planned

| # | Item | Description |
|---|---|---|
| 1 | Test execution + reporting | `testpilot run`: run the generated scripts with the project's own Playwright and produce a test report, with options mirroring the main `npx playwright test` flags (e.g. `--headed`, `--project`, `--reporter`). |
| 2 | Input variables | Let a test case reference variables (e.g. login credentials) by name instead of writing values into the steps. Values are supplied at invocation time and the generated script reads them rather than hard-coding them. |
| 3 | Retry extraction failures | Retry a step when the Extractor fails: an `ExtractorError` such as running out of turns currently aborts the run, while validation failures already re-extract the failing step within a run-wide `MAX_RETRIES` of 5. Count Extractor retries against the same budget, and make that budget configurable rather than a constant. |
| 4 | Pre-conditions | Let a test case declare the state it starts from (e.g. a logged-in user, an item in the cart), and define how that state is established before the steps run. |
| 5 | Multiple markdown inputs | Accept several `.md` files in one invocation, producing one test script per input or a single bundled script. |
| 6 | Generic prompt input | Accept a free-form user prompt instead of a structured markdown test case; the agent analyses it and builds the structured test case itself. |
| 7 | Frontend | A client–server application: a frontend (client) talking to a server that runs the pipeline, replacing the single local CLI. |

## Carried over

Earlier plans and code reviews also raised these.

| # | Item | Description |
|---|---|---|
| 8 | Docker | Containerise the application. Playwright MCP runs in-process and shares the application's browser build, so one image (e.g. based on the official Playwright image) can hold both. |
| 9 | Locale support | Support pages in more than one locale (e.g. en-US and pt-PT). The Playwright MCP locale is fixed per server, so this needs one locale per test case (one server per locale) or language-neutral locators. |
| 10 | Multi-line statements | Allow a collected statement to span several lines; collected code is currently split line by line. |
| 11 | Integration tests | An optional test suite exercising a live LLM and Playwright MCP server, on top of the offline suite. Also unit tests for the retrying conversation wrapper. |
