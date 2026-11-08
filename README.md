# TestPilot

TestPilot (alpha) turns a test case written in markdown into an executable Playwright (TypeScript) test script, using an LLM.

An LLM agent performs each step of the test case in a real browser through [Playwright MCP](https://github.com/microsoft/playwright-mcp) and keeps only the code Playwright reports running. Each step's code is then replayed in a clean browser and checked by the LLM before it is accepted. The validated code is assembled into a Playwright Test (`@playwright/test`) spec.

- [Application description](docs/APP_DESCRIPTION.md): architecture, pipeline stages, requirements and design decisions
- [Roadmap](docs/ROADMAP.md): what is planned next

## Prerequisites

- Node.js 24 or newer (runs the TypeScript sources directly)
- An Azure OpenAI deployment

## Setup

**Once per machine**, install testpilot from its repository:

```bash
git clone https://github.com/edupro26/testpilot.git
cd testpilot
npm ci && npm link
```

`npm ci` installs the dependencies and the Chromium build testpilot drives while generating; `npm link` puts the `testpilot` command on your PATH. To update later: `git pull && npm ci`.

**Once per project**, inside the webapp project you want tests for:

```bash
npm init playwright@latest            # only if the project has no Playwright yet
testpilot init                        # check the setup and create .testpilot/
```

Then set your Azure OpenAI up (see [Configuration](#configuration)) and run `testpilot doctor` to confirm everything is in place. `doctor` prints the command that fixes anything missing.

The generated scripts run with the project's own Playwright and `playwright.config.*`; testpilot's own Playwright is only used while generating.

### Configuration

Settings live in the project's `.testpilot/config.json`; every key is optional and falls back to its default:

```json
{
    "llmProvider": "azure_openai",
    "azureOpenAI": {
        "endpoint": "https://<resource>.openai.azure.com/",
        "modelName": "gpt-5.5",
        "deploymentName": "gpt-5.5",
        "apiVersion": "2025-04-01-preview"
    },
    "scriptsDir": "testpilot",
    "maxTurns": 25,
    "locale": "en-US",
    "logLevel": "info"
}
```

Each setting can be overridden by its `TESTPILOT_` environment variable, from the shell, `.env` or `.env.local`. Only `TESTPILOT_` variables are read, so the project's own variables are never picked up. The API key is only read from the environment, never from `config.json`.

| `config.json` | Environment variable | Description |
|---|---|---|
| `llmProvider` | `TESTPILOT_LLM_PROVIDER` | `azure_openai`, the only provider for now (default) |
| `azureOpenAI.endpoint` | `TESTPILOT_AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint |
| `azureOpenAI.modelName` | `TESTPILOT_AZURE_MODEL_NAME` | Model name behind the deployment |
| `azureOpenAI.deploymentName` | `TESTPILOT_AZURE_DEPLOYMENT_NAME` | Azure deployment name |
| `azureOpenAI.apiVersion` | `TESTPILOT_OPENAI_API_VERSION` | Azure OpenAI API version |
| (none) | `TESTPILOT_AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `scriptsDir` | `TESTPILOT_SCRIPTS_DIR` | Folder the generated scripts go to (default `testpilot`) |
| `maxTurns` | `TESTPILOT_MAX_TURNS` | Maximum agent turns per step (default `25`) |
| `locale` | `TESTPILOT_LOCALE` | Locale of all three browsers: Playwright MCP's, the validation browser and the generated script's (default `en-US`) |
| `logLevel` | `TESTPILOT_LOG_LEVEL` | Logging level (default `info`) |

Precedence, weakest first: the defaults, `config.json`, `.env`, `.env.local`, the shell environment, and the flags of the command being run (`generate --out`, `--max-turns`, `--locale`, `--log-level`).

#### Setting Azure OpenAI up

`testpilot config set-azure-openai` writes the Azure settings to `.testpilot/config.json` (and sets `llmProvider`), keeping every other key:

```bash
testpilot config set-azure-openai \
    --endpoint=https://<resource>.openai.azure.com/ \
    --model-name=gpt-5.5 \
    --deployment-name=gpt-5.5 \
    --api-version=2025-04-01-preview
```

Give any of the four values; each one given overwrites the stored value and the others are kept. The API key is never a flag, so it stays out of shell history. Run this in your own terminal to be asked for it with hidden input:

```bash
testpilot config set-azure-openai --prompt-api-key
```

The key is written to `.env.local` at the project root as `TESTPILOT_AZURE_OPENAI_API_KEY`, never to `config.json`, and never printed. `--save=dotenv[:path]` also writes the given values to a dotenv file as their `TESTPILOT_` variables, and makes it the file the key goes to: `.env.local` for plain `--save=dotenv`, or `<path>` (relative to the working directory) for `--save=dotenv:<path>`. Only the `TESTPILOT_` lines are added or updated; the rest of the file is kept. Keep that file out of git. testpilot reads only `.env` and `.env.local` at the project root, so it warns when the file written is another one (load it into the environment yourself), and when a stronger source (`.env.local`, the shell) still overrides a value just written. Check the result with `testpilot config list` and `testpilot doctor`.

## Usage

1. Run the pipeline on a test case. Playwright MCP runs inside the application, so there is no server to start first:

    ```bash
    testpilot generate examples/automation/test_login_incorrect_credentials.md
    ```

    It writes the generated script to the scripts folder (`scriptsDir`, `testpilot/` by default; this repo sets it to `output/testpilot/`), the validated test case to `.testpilot/tests/`, and a log of the run to `.testpilot/logs/`, all named after the input file. Progress goes to stderr, whose first and last line is `Log: <path>`; whenever nothing has been logged for 30 seconds it logs `Still working on <stage>, step "<step>" (<n>s)`, so a long run never looks stuck. When the run succeeds, stdout gets the three paths, relative to the working directory:

    ```
    spec: output/testpilot/test_login_incorrect_credentials.spec.ts
    test case: .testpilot/tests/test_login_incorrect_credentials.json
    log: .testpilot/logs/2026-11-07_19-02-16-test_login_incorrect_credentials.log
    ```

    Flags change one run without touching the settings:

    | Flag | Overrides | Effect |
    |---|---|---|
    | `--headed` | (none) | Shows the browser the agent drives, to watch it work; the validation browser stays headless |
    | `--out=<dir>` | `scriptsDir` | Writes the script to `<dir>`, relative to the working directory |
    | `--max-turns=<n>` | `maxTurns` | Maximum agent turns per step |
    | `--locale=<locale>` | `locale` | Locale of the browsers and the generated script |
    | `--log-level=<level>` | `logLevel` | Logging level, on stderr and in the log file |
    | `--json` | (none) | Prints the result as one JSON object on stdout instead of the three paths, for a failure too |

    An invalid flag value (e.g. `--max-turns=0`) is a configuration error: it names the flag and exits with status 2.

    `--json` prints this object, and nothing else, on stdout (the progress log stays on stderr):

    ```json
    {
      "status": "failure",
      "exitCode": 1,
      "spec": null,
      "testCase": null,
      "log": "/work/project/.testpilot/logs/2026-11-07_19-02-16-test_login.log",
      "error": {
        "code": null,
        "type": "ExtractorError",
        "stage": "extract",
        "step": "Verify the welcome message",
        "message": "..."
      }
    }
    ```

    `spec`, `testCase` and `log` are absolute paths, `null` when the file was not written (`log` is `null` if the run failed before the log opened); on success `error` is `null`. `stage` is `structure`, `extract`, `validate` or `generate` (`null` before the first), and `step` is the step being extracted or whose replay failed (`null` if none). `type` is the error's class name; `code` is reserved and always `null` for now. A missing input file reports `UsageError` and an invalid configuration `ConfigurationError`, both with exit code `2`.

2. Run the generated test:

    ```bash
    npx playwright test output/testpilot/test_login_incorrect_credentials.spec.ts            # headless
    npx playwright test output/testpilot/test_login_incorrect_credentials.spec.ts --headed   # watch it run
    npx playwright show-report                                                               # open the HTML report of the last run
    ```

3. Check which settings testpilot uses, and where each value comes from (the default, `config.json`, `.env`, `.env.local` or the shell). The API key is masked:

    ```bash
    testpilot config list
    testpilot --version
    ```

### Exit codes

Every command exits with `0` on success (and for `--help` or `--version`), `1` when the test case failed to generate, and `2` for a setup, usage or configuration error: an unknown command or option, a missing argument, an invalid setting, a missing input file or API key, a rejected API key or deployment (HTTP 401, 403, 404), or Chromium that cannot launch.

### Writing a test case

A test case is a markdown file with a title, the URLs it visits and numbered steps. See `examples/` for more.

```markdown
# Add item to the shopping cart

urls = ["https://www.saucedemo.com/", "https://www.saucedemo.com/inventory.html"]

## Steps

1. Launch browser and navigate to url 'https://www.saucedemo.com/'
2. Verify that the Login Section is visible successfully
3. Enter the username 'standard_user' and the password 'secret_sauce'
4. Click on the 'Login' button
5. Verify that the Products are visible successfully
```

## Development

```bash
npm run typecheck   # type-check (tsc)
npm run lint        # lint (ESLint)
npm run format      # format (Prettier)
npm test            # run the test suite (offline: mock LLM, fake MCP server)
npm run check       # all of the above, without writing
```

Type-check, lint, format and tests must pass before committing. Code conventions are in [AGENTS.md](AGENTS.md).
