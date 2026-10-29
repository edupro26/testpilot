# TestPilot

TestPilot (alpha) turns a test case written in markdown into an executable Playwright (Python) test script, using an LLM.

An LLM agent performs each step of the test case in a real browser through [Playwright MCP](https://github.com/microsoft/playwright-mcp) and keeps only the code Playwright reports running. Each step's code is then replayed in a clean browser and checked by the LLM before it is accepted. The validated code is assembled into a `pytest-playwright` test.

- [Application description](docs/APP_DESCRIPTION.md): architecture, pipeline stages, requirements and design decisions
- [Roadmap](docs/ROADMAP.md): what is planned next

## Prerequisites

- Python ≥3.13 and [uv](https://docs.astral.sh/uv/)
- Node.js 18 or newer (for `npx`, to run the Playwright MCP server)
- An Azure OpenAI deployment (or `LLM_PROVIDER=mock` for offline runs)

## Setup

```bash
uv sync --locked --dev                                          # install dependencies
uv run playwright install chromium                              # browser for validation and the generated tests
npx @playwright/mcp@latest install-browser chrome-for-testing   # browser for the Playwright MCP server
cp .env.example .env                                            # then fill in your settings
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
| `BROWSER_LOCALE` | Locale of the validation browser and the generated script (default `en-US`); must match `mcp/config.json` |
| `MCP_URL` | Playwright MCP server URL (default `http://localhost:8931/mcp`) |
| `MCP_MAX_TURNS` | Maximum agent turns per step (default `25`) |
| `LOG_LEVEL` | Logging level (default `INFO`) |

## Usage

1. Start the Playwright MCP server in a separate terminal and leave it running:

    ```bash
    npx @playwright/mcp@latest --config ./mcp/config.json
    ```

2. Run the pipeline on a test case:

    ```bash
    uv run python -m src.main examples/automation/test_login_incorrect_credentials.md
    ```

    It writes the validated test case and the generated script to `output/<folder>/`, named after the input file:

    ```
    output/automation/test_login_incorrect_credentials.json
    output/automation/test_login_incorrect_credentials.py
    ```

3. Run the generated test:

    ```bash
    uv run pytest output/automation/test_login_incorrect_credentials.py           # headless
    uv run pytest output/automation/test_login_incorrect_credentials.py --headed  # watch it run
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
uv run ruff check --fix .   # lint
uv run ruff format .        # format
uv run pytest -q            # run the test suite (offline: mock LLM, fake MCP server)
```

Lint and tests must pass before committing. Code conventions are in [AGENTS.md](AGENTS.md).
