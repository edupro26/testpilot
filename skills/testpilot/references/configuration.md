# Configuration

Read this when a setting is missing or wrong, or to set Azure OpenAI up. It covers
where testpilot reads its settings from, which wins, and how the LLM settings get set
without you touching the API key.

## Where settings come from

Each setting can come from several places. testpilot reads them in this order, and
each one overrides the ones before it:

1. the default,
2. `.testpilot/config.json`,
3. `.env` at the project root,
4. `.env.local` at the project root,
5. the shell environment,
6. a flag of the command being run (only `generate` has such flags).

`testpilot config list` shows each setting's effective value and which of these it
came from (`default`, `config.json`, `.env`, `.env.local`, `environment`, `flag`).
Run it instead of opening the files. When a value is invalid, it prints no list: it
exits `2` with an `Invalid configuration:` error on stderr that names the setting
and the source its value came from (for `config.json`, the file and the problem).
Relay that error; the fix belongs in that source (`CONFIG_INVALID` in `errors.md`).

### `.testpilot/config.json`

The project's settings file, created by `testpilot init`. Every key is optional:

```json
{
    "llmProvider": "azure_openai",
    "azureOpenAI": {
        "endpoint": "https://<resource>.openai.azure.com/",
        "modelName": "<model>",
        "deploymentName": "<deployment>",
        "apiVersion": "<api version>"
    },
    "scriptsDir": "testpilot",
    "maxTurns": 25,
    "locale": "en-US",
    "logLevel": "INFO"
}
```

It never holds the API key: testpilot refuses to run while it does
(`API_KEY_IN_CONFIG` in `errors.md`). An unknown key or an invalid value is
`CONFIG_INVALID`.

### The `TESTPILOT_` variables

Every setting also has an environment variable. They are read from the shell
environment and from the dotenv files `.env` and `.env.local` at the project root,
and from no other file. Only variables starting with `TESTPILOT_` are read, so the
project's own variables are never picked up.

| `config.json` key | Variable | What it is |
|---|---|---|
| `llmProvider` | `TESTPILOT_LLM_PROVIDER` | The LLM provider: `azure_openai`, the only one and the default |
| `azureOpenAI.endpoint` | `TESTPILOT_AZURE_OPENAI_ENDPOINT` | The Azure OpenAI endpoint |
| `azureOpenAI.modelName` | `TESTPILOT_AZURE_MODEL_NAME` | The model behind the deployment |
| `azureOpenAI.deploymentName` | `TESTPILOT_AZURE_DEPLOYMENT_NAME` | The Azure deployment name |
| `azureOpenAI.apiVersion` | `TESTPILOT_OPENAI_API_VERSION` | The Azure OpenAI API version |
| (none) | `TESTPILOT_AZURE_OPENAI_API_KEY` | The API key: environment and dotenv files only |
| `scriptsDir` | `TESTPILOT_SCRIPTS_DIR` | The folder generated scripts go to (default `testpilot`; `init` sets it inside the project's Playwright `testDir`) |
| `maxTurns` | `TESTPILOT_MAX_TURNS` | The browser agent's turn limit per step (default `25`) |
| `locale` | `TESTPILOT_LOCALE` | The browsers' locale, and the generated script's (default `en-US`) |
| `logLevel` | `TESTPILOT_LOG_LEVEL` | The logging level (default `INFO`; any case is accepted) |

The five Azure OpenAI settings, the API key included, have no default and are all
required: `generate` stops with `LLM_SETTINGS_MISSING` while one is not set, and
`doctor` fails its LLM settings check.

### The dotenv files

`.env` and `.env.local` hold `TESTPILOT_` variables as `NAME=value` lines; `.env.local`
overrides `.env`. Either may hold the API key, so do not open, read or edit them.
To know what they set, run `testpilot config list`. When a change is needed in one,
tell the developer which variable to change in which file, and let them do it.

## Setting Azure OpenAI up

Do it when `testpilot config list` shows an Azure setting as `(not set)`, `doctor`
fails the LLM settings check, or `generate` fails with `LLM_SETTINGS_MISSING`.

1. Run `testpilot config list` and note which settings are `(not set)`. If it exits
   `2` instead, a value is invalid: relay its error (above) before anything else.
2. For the endpoint, the model name, the deployment name and the API version: ask the
   developer for the values. Do not guess them, and do not copy them from elsewhere
   without asking.
3. Run `testpilot config set-azure-openai` with the values they gave you
   (`testpilot config set-azure-openai --help` lists the flags). It writes them to
   `.testpilot/config.json`, sets `llmProvider` to `azure_openai`, and keeps every
   other key.
4. If it warns that a value is still taken from a stronger source (`.env.local`, the
   shell environment), the value you wrote does not take effect. Tell the developer
   which source still sets it; changing that is theirs to do.
5. If the API key is not set, see below.
6. Run `testpilot doctor` to confirm the LLM settings check passes.

## The API key

The key is never yours to handle. Never ask for it, read it, write it or print it,
not even in a file or a command line. The developer sets it, in their own terminal:

```bash
testpilot config set-azure-openai --prompt-api-key
```

It asks for the key with hidden input and writes it to `.env.local` at the project
root as `TESTPILOT_AZURE_OPENAI_API_KEY`, never to `config.json`, and never prints it.
Never run this command yourself: your terminal is a real one, so testpilot cannot tell
you from the developer. Tell the developer to run it, and that `.env.local` must stay
out of git. Once the developer says they have run it, run `testpilot config list`:
the key shows as set, masked; say only that it is set.

When the LLM service rejects the key (`LLM_AUTH_FAILED` in `errors.md`), the fix is
the same: the developer runs that command again in their own terminal.
