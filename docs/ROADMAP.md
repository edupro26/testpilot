# Roadmap

What is planned next for the application. The current design is described in [APP_DESCRIPTION.md](./APP_DESCRIPTION.md).

## Priority: Copilot agent integration with skills

Comes before every other item. The goal is to let an agent such as GitHub Copilot in VS Code drive testpilot from inside a developer's own webapp project: testpilot is installed once per machine, set up once per project, and the agent learns how to use it from skills. The three tasks are done, so this section has no planned work left (one known gap is noted under C, "Still open"); the items under Planned come next.

| # | Task | Description | Status |
|---|---|---|---|
| A | Installation and project setup | Go from `git clone` to a `testpilot` command on the PATH, and set a project up with `testpilot init`. Detailed below. | Done |
| B | CLI commands | Design and build every command and flag the agent needs. Detailed below. | Done |
| C | Skills | Write the skill that teaches an agent how to use testpilot, installed by `testpilot init --skills`, with stable error codes and hints. Detailed below. | Done |

### A. Installation and project setup (done)

**Once per machine**, inside the testpilot clone:

```bash
git clone https://github.com/edupro26/testpilot.git
cd testpilot
npm ci && npm link
npx playwright install
```

`npm ci` installs the dependencies and `npm link` puts the `testpilot` command on the PATH. `npx playwright install`, run inside the clone, downloads the browser builds testpilot's own Playwright uses (Chromium, Firefox and WebKit; testpilot drives Chromium today); it is a no-op when they are already there. There is no `postinstall` script: npm gates install scripts of globally installed packages (it warns today and may skip them later), so the browser install is an explicit step.

**Once per project**, inside the webapp project:

```bash
npm init playwright@latest            # only if the project has no Playwright yet
testpilot init
```

Generated tests run with the project's own Playwright and `playwright.config.*`, so its browsers, headed mode, reporters, screenshots and results folder all apply. Testpilot keeps its own Playwright only for the browsers it drives while generating (Playwright MCP and validation). Each Playwright version uses its own Chromium build, stored side by side in the shared Playwright cache, so the two installs never replace each other's browser.

**`testpilot doctor`** checks the setup and, for every failure, prints the exact command that fixes it:

- Node.js ≥ 24
- testpilot's Chromium build is installed (it can be removed by Playwright's cleanup if the clone is moved or deleted)
- the project has `@playwright/test` and a `playwright.config.*`, warning when its Playwright is older than testpilot's (the code Playwright MCP emits follows testpilot's version); when `package.json` already lists `@playwright/test`, the fix is `npm install` rather than `npm init playwright@latest`
- the LLM settings are valid and present, API key included (a broken `config.json` or an unreadable `.env` is a failed check, never a crash)

It exits with `2` when any check fails; warnings do not fail.

**`testpilot init`** runs `doctor` first and stops on a failed check, except the LLM settings check (the LLM is configured afterwards). It then reads the project's `testDir` and writes only what testpilot cannot know by itself:

```
.testpilot/
    .gitignore                  # ignores logs/, tests/ and .playwright-mcp/
    config.json                 # { "scriptsDir": "<testDir>/testpilot" }
```

Every other setting keeps its default until it is set, and the Azure block comes from `config set-azure-openai`. The rest of `.testpilot/` is created by `generate` when it first writes there:

```
.testpilot/
    .playwright-mcp/            # Playwright MCP output
    logs/                       # one log per generate run
    tests/                      # the validated JSON test case of each run
```

Without a string-literal `testDir` in the Playwright config, `scriptsDir` falls back to `testpilot` (Playwright's default `testDir` is the config's own folder), with a warning when `testDir` is set some other way.

Re-running `init` is safe: it never overwrites an existing file, and only adds `scriptsDir` to a `config.json` that lacks it; a `config.json` that is not a valid JSON object is left untouched for the developer to fix. That is also how `init --skills` adds or updates the skill in a project already set up; the skill folder is the one exception to never overwriting: `init --skills` replaces it whole, hand edits included.

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
    "maxTurns": 25,
    "locale": "en-US",
    "logLevel": "info"
}
```

`scriptsDir` is set by `init` to `<testDir>/testpilot/`, so Playwright picks the generated specs up. `llmProvider` accepts only `azure_openai` (the default) for now.

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

Precedence, weakest first: defaults, `config.json`, the project's `.env`, the project's `.env.local`, the shell environment, command flags. Testpilot only reads `.env` and `.env.local`; it writes to a dotenv file only when asked to (`config set-azure-openai`), and then touches only its own `TESTPILOT_` lines. A developer who wants the same key in every project exports it in their shell profile.

Out of scope for now: publishing testpilot to a package registry. That needs a build step (Node does not strip types from `.ts` files inside `node_modules/`), and is planned later.

### B. CLI commands (done)

`src/main.ts` is the thin entrypoint, `src/cli/` holds the commander program (`cli.ts`) plus one file per command (`generate.ts`, `doctor.ts`, `init.ts`, `config.ts`) and the shared exit handling (`errors.ts`), and `src/runtime/` holds the pipeline (`pipeline.ts`) and its errors (`exceptions.ts`). New commands are registered in `buildProgram()` in `src/cli/cli.ts`. `testpilot config` has only the `list` and `set-azure-openai` subcommands; other settings are edited by hand in `config.json`.

| Command | What it does | Status |
|---|---|---|
| `testpilot --help`, `testpilot help <command>`, `testpilot <command> --help` | Usage, from commander | Done |
| `testpilot doctor` | Checks the setup and prints the fix for each failure (task A) | Done |
| `testpilot init` | Sets the project up (task A) | Done |
| `testpilot generate <path.md>` | Generates the script for a test case (below) | Done |
| `testpilot --version` | The installed version | Done |
| `testpilot config list` | Every effective setting, the source it came from, API keys masked | Done |
| `testpilot config set-azure-openai` | Writes the Azure OpenAI settings (below) | Done |
| `testpilot init --skills[=<agent>]` | Also installs the skill into the project (task C) | Done |
| `testpilot init --skills[=<agent>] -g` | Installs the skill into the user's agent folder (e.g. `~/.copilot/skills/`) for every project (task C) | Done |
| `testpilot run <path.spec.ts>` | Runs a generated script with the project's Playwright; see Planned item 1 | Later |
| `testpilot update` | `git pull && npm ci && npx playwright install` in the clone, then re-checks testpilot's Chromium | Later |
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
- Called with none of the four values and without `--prompt-api-key`, it writes nothing and exits with `2`; so does `--prompt-api-key` outside an interactive terminal.
- Writing a dotenv file adds or updates testpilot's own lines and keeps everything else. Keeping that file out of git is the developer's responsibility.
- The dotenv file is written before `config.json`. Afterwards the settings are resolved again: a warning on stderr names each variable just written that a stronger source still overrides (e.g. `TESTPILOT_AZURE_OPENAI_ENDPOINT is still taken from .env.local, which overrides .testpilot/config.json`), and a `--save` file other than the project root's `.env` or `.env.local`, which testpilot does not read. No value is printed, and the exit code stays `0`.

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

- `--headed` shows the browser the agent drives. It reaches only the Playwright MCP browser; the validation browser stays headless.
- `--out`, `--max-turns`, `--locale` and `--log-level` override `scriptsDir`, `maxTurns`, `locale` and `logLevel` for this run, and beat every other settings source. `--out` resolves against the working directory; an invalid value exits with `2` naming the flag (`--max-turns (from flag): ...`).
- `--json` prints one result object on stdout instead of the three paths, for success and failure alike (the object is described in the README's Usage).
- The spec goes to the scripts folder (`scriptsDir`), the validated JSON to `.testpilot/tests/` and the log to `.testpilot/logs/`, all named after the input file; the log's name starts with the run's local start time (`<YYYY-MM-DD_HH-MM-SS>-<stem>.log`, with `_2`, `_3`, … after the time when a run of the same input started in the same second). On success stdout gets `spec:`, `test case:` and `log:` lines, relative to the working directory. This repo sets `scriptsDir` to `output/testpilot` in its own `.testpilot/config.json`, which `playwright.config.ts` (`testDir: './output'`) covers.

**Built for agents.** Every command:

- never prompts unless it runs in an interactive terminal, so an agent never hangs on a question: the only stdin reader is `readHiddenInput` (`src/cli/config.ts`), used by `config set-azure-openai --prompt-api-key`, which refuses to run without a terminal;
- exits with `0` on success, `1` when the test case fails to generate, `2` on a setup or config error (true for `doctor`, `init`, invalid settings, a missing input file and, in `generate`, a missing or rejected API key (HTTP 401, 403, 404) and a Chromium that cannot launch, see `exitCodeFor` in `src/cli/errors.ts`) and for commander's own usage errors (an unknown command or option, a missing argument); only help and version output exit `0` (`runCli` maps a `CommanderError` to `0` or `2`);
- writes progress to stderr and results to stdout; `generate` logs the log path as the first and the last line, whatever the log level;
- reports progress steadily during long runs (`generate` takes minutes), so it never looks stuck: a run-level watchdog in `generate` (`watchProgress`, `src/cli/generate.ts`) checks every 5 seconds when the last line was logged (`lastLineAt`, `src/logger.ts`), and after 10 seconds without one logs `Waiting for <stage> to finish: step <i> of <n>, "<step>" (<s>s)` from the run's progress (the step part only while a step is extracted), `<s>` counting from the last line that was not its own; it repeats every 10 seconds while the quiet lasts, so no gap exceeds 15 seconds (VS Code's terminal tool, with basic shell integration, treats 30 seconds without output as the command having finished).

### C. Skills (done)

One skill, `testpilot`, in the [Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) format: a `SKILL.md` with a name and description, plus reference files the agent reads only when it needs them. Copilot and Claude read the same format, so the same files are copied for every agent; only the destination differs. Its source is `skills/testpilot/` in the testpilot repo:

```
skills/testpilot/
    SKILL.md                         # when to use it, the usual flow, waiting for generate, hard rules
    references/
        commands.md                  # what each command is for and when to use it
        configuration.md             # config.json, TESTPILOT_ variables, precedence, LLM setup
        test-case-format.md          # the markdown testpilot expects, with a template
        errors.md                    # every error code: cause and fix
```

**Installing it.** `testpilot init --skills[=<agent>] [-g]` (`src/cli/skills.ts`, called from `init`) copies the folder over any `testpilot` skill already there, so re-running it updates the skill and drops files the source no longer has.

| `--skills` | Project | With `-g` (the user, for every project) |
|---|---|---|
| (no value) or `agents` | `.agents/skills/testpilot/` | `~/.agents/skills/testpilot/` |
| `=copilot` | `.github/skills/testpilot/` | `~/.copilot/skills/testpilot/` |
| `=claude` | `.claude/skills/testpilot/` | `~/.claude/skills/testpilot/` |

`.agents/skills/` is the default because VS Code Copilot reads it. Without `-g`, `init` installs the skill first, then runs its checks (which see the new copy), and writes `.testpilot/` only if they pass; the skill stays installed whatever they said. With `-g` only the user copy is installed and the project is neither checked nor changed. `-g` without `--skills` and an unknown agent exit with `2`. `doctor` compares each installed copy with the bundled one (same files, byte-equal) and warns, without failing, when one differs, printing the `init --skills ...` command that updates it.

**What the agent does** (the skill's hard rules):

- The developer brings the test. The agent uses their markdown file, or turns the steps they wrote in the prompt into a file following `test-case-format.md`; for a vague request it asks for the steps and never makes any up. It may look at the site with its own browser tools to sharpen a step's wording, not to add steps. A new file goes in the folder where the project already keeps test cases, or `.testpilot/input/`.
- It runs `testpilot doctor` when unsure of the setup, then `testpilot generate <path.md> --json`, waits for it to finish (it takes minutes) and reports the spec path; it does not run the spec.
- On a failure it relays the error code, stage, step, message, hint and log path from the `--json` result, recommends a fix when there is a concrete one, and waits: it never edits the test case or settings and re-runs on its own, and never guesses at a cause testpilot did not report.
- It runs `doctor`, `config list`, `init` and `config set-azure-openai` with non-secret values freely, but asks before every `npx` or `npm` command and before `init --skills`.
- It never handles the API key. VS Code Copilot runs commands in a real integrated terminal (`isTTY` is true), so the TTY check cannot stop it; the rule does: the developer runs `testpilot config set-azure-openai --prompt-api-key` in their own terminal.

**Error codes and hints.** Every `generate` failure after the arguments parse has one of 21 stable codes (`UPPER_SNAKE_CASE`) with a fixed exit code and a static hint, catalogued in `ERROR_CODES` (`src/error-codes.ts`). `generate --json` reports `code` and `hint` in `error`; without `--json` the final error line is `CODE: message` followed by `Hint: <hint>`. Every `PipelineError` carries its code, set where it is thrown; `errorCodeFor` (`src/cli/errors.ts`) classifies everything else by walking the `cause` chain. `skills/testpilot/references/errors.md` maps each code to its cause and fix.

**The task-B gaps task C settled:**

- `ApiKeyInConfigError` (an API key in `config.json`) is `API_KEY_IN_CONFIG`, exit `2`.
- A log folder that cannot be created is a `LogFolderError` (`src/cli/errors.ts`), reported as `LOG_DIR_FAILED`, exit `2`.
- A wrong endpoint host (the OpenAI client's `APIConnectionError`) stays exit `1`, as `LLM_UNREACHABLE`; only 401, 403 and 404 are setup errors.
- Missing Azure settings keep `stage: null`: the provider is built, and fails, before the structure stage starts. The code is `LLM_SETTINGS_MISSING`.
- `generate`'s message for missing settings names the missing `TESTPILOT_` variables, while `doctor` and `init` still say `Missing required configuration variables`. The code and hint, and `doctor`'s `fix:` line, carry the next step either way.
- A `ValidatorError` (`STEP_VALIDATION_FAILED`) still reports `stage` `extract` or `validate`, depending on whether a re-extraction ran before the last replay; the code and `error.step` identify it, and the stage is only context.

**Still open:** the logger does not mask the API key in third-party error messages (none is known to include it); worth adding if errors get richer.

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
