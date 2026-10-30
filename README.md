# TestPilot

TestPilot (alpha) turns a test case written in markdown into an executable Playwright (TypeScript) test script, using an LLM.

An LLM agent performs each step of the test case in a real browser through [Playwright MCP](https://github.com/microsoft/playwright-mcp) and keeps only the code Playwright reports running. Each step's code is then replayed in a clean browser and checked by the LLM before it is accepted. The validated code is assembled into a Playwright Test (`@playwright/test`) spec.

- [Application description](docs/APP_DESCRIPTION.md): architecture, pipeline stages, requirements and design decisions
- [Roadmap](docs/ROADMAP.md): what is planned next

## Prerequisites

- Node.js 24 or newer (runs the TypeScript sources directly)
- An Azure OpenAI deployment (or `LLM_PROVIDER=mock` for offline runs)

## Setup

```bash
npm ci                                # install dependencies
npx playwright install chromium       # browser for Playwright MCP, validation and the generated tests
npm link                              # put the `testpilot` command on your PATH
cp .env.example .env                  # then fill in your settings
```

### Configuration

Settings are read from the environment or `.env`:

| Variable | Description |
|---|---|
| `LLM_PROVIDER` | `azure_openai` or `mock` (default `mock`) |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_DEPLOYMENT_NAME` | Azure deployment name |
| `AZURE_MODEL_NAME` | Model name behind the deployment |
| `OPENAI_API_VERSION` | Azure OpenAI API version |
| `BROWSER_LOCALE` | Locale of all three browsers: Playwright MCP's, the validation browser and the generated script's (default `en-US`) |
| `MCP_MAX_TURNS` | Maximum agent turns per step (default `25`) |
| `LOG_LEVEL` | Logging level (default `INFO`) |

## Usage

1. Run the pipeline on a test case. Playwright MCP runs inside the application, so there is no server to start first:

    ```bash
    testpilot examples/automation/test_login_incorrect_credentials.md
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
