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

Then add your Azure OpenAI settings to `.testpilot/config.json`, set `TESTPILOT_AZURE_OPENAI_API_KEY` (in the shell, `.env` or `.env.local`), and run `testpilot doctor` to confirm everything is in place. `doctor` prints the command that fixes anything missing.

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
    "scriptsDir": "tests/testpilot",
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
| `scriptsDir` | `TESTPILOT_SCRIPTS_DIR` | Folder the generated scripts go to (default `tests/testpilot`) |
| `maxTurns` | `TESTPILOT_MAX_TURNS` | Maximum agent turns per step (default `25`) |
| `locale` | `TESTPILOT_LOCALE` | Locale of all three browsers: Playwright MCP's, the validation browser and the generated script's (default `en-US`) |
| `logLevel` | `TESTPILOT_LOG_LEVEL` | Logging level (default `info`) |

Precedence, weakest first: the defaults, `config.json`, `.env`, `.env.local`, the shell environment.

## Usage

1. Run the pipeline on a test case. Playwright MCP runs inside the application, so there is no server to start first:

    ```bash
    testpilot generate examples/automation/test_login_incorrect_credentials.md
    ```

    It writes the validated test case and the generated script to `output/<folder>/`, named after the input file:

    ```
    output/automation/test_login_incorrect_credentials.json
    output/automation/test_login_incorrect_credentials.spec.ts
    ```

2. Run the generated test:

    ```bash
    npx playwright test output/automation/test_login_incorrect_credentials.spec.ts            # headless
    npx playwright test output/automation/test_login_incorrect_credentials.spec.ts --headed   # watch it run
    npx playwright show-report                                                               # open the HTML report of the last run
    ```

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
