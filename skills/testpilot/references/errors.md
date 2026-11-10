# Errors

Read this when `testpilot generate` fails, before you tell the developer what went
wrong. Every failure ends with one stable error code; this file says what each code
means, what the developer can do about it, and what you may add in plainer words.

## Reading a failed `generate --json` result

A failed run prints one JSON object on stdout and exits with a non-zero status.

| Field | What it tells you |
|---|---|
| `status` | `"failure"`. |
| `exitCode` | `2`: a setup problem (the project, the configuration, the LLM credentials, the browser); the developer has to fix it, and a re-run will fail the same way until they do. `1`: this test case failed to generate; a re-run may work, or the steps may need rewording. The process exit status is the same number. |
| `error.code` | The stable error code: the heading of the section below that explains it. |
| `error.hint` | What to do about it, fixed for the code. The section below quotes it. |
| `error.stage` | Where the run was: `structure` (reading the markdown), `extract` (the agent performing the steps in a browser), `validate` (replaying the script and checking it) or `generate` (assembling the script). `null` when the run failed before the first stage. |
| `error.step` | The step being extracted, or whose replay failed. `null` when no step was involved. |
| `error.message` | testpilot's own description of the failure. Quote it as it is. |
| `error.type` | The error's class name, e.g. `ExtractorError`. Not useful to the developer. |
| `log` | The run's log file, absolute. `null` when there is no log: the run failed before the log opened (`INPUT_NOT_FOUND`, `CONFIG_INVALID`, `API_KEY_IN_CONFIG`, `OUTPUT_CONFLICT`, `LOG_DIR_FAILED`), or the log file could not be created, which stderr warns about. |
| `testCase` | Usually `null`. After a failure in the `generate` stage it is the path of the validated test case JSON, which the run had already written. |
| `spec` | Always `null` on a failure: no script was written. |

Without `--json`, the same failure shows on stderr as `<CODE>: <message>` followed by
a `Hint: <hint>` line. Once the run has opened its log, stderr also has a `Log: <path>`
line at the start and another at the end; the failures that come before that
(`INPUT_NOT_FOUND`, `CONFIG_INVALID`, `API_KEY_IN_CONFIG`, `OUTPUT_CONFLICT`,
`LOG_DIR_FAILED`) have no log and print no `Log:` line, and neither does a run whose
log file could not be created. Only the `--json` result names the stage and the step
as fields.

## What you tell the developer

1. Relay testpilot's report as fully as you can: the error code, the stage, the step,
   testpilot's message, the hint, and the log path. Do not shorten it to "it
   failed".
2. You may add a plainer explanation for a developer who would not follow the raw
   report, but only from testpilot's report and from this file: the **Cause** and **In
   plain words** lines of the code's section. Never guess at a cause testpilot did not
   report.
3. When neither testpilot's report nor this file explains the failure, say so, and
   point to the log. You may read the log and quote the relevant lines; do not
   interpret beyond what they say.
4. Recommend the fix, then wait. Do not edit the test case or the settings, and do
   not run `generate` again, until the developer agrees. This holds for a plain
   re-run too: when the hint is only "try again", say so and wait for their go-ahead.
5. Setup commands:
   - You may run these yourself: `testpilot doctor`, `testpilot config list`,
     `testpilot init` (without `--skills`), and `testpilot config set-azure-openai`
     with values the developer gave you that are not secret (the endpoint, the model
     name, the deployment name, the API version).
   - Ask first, every time: any `npx` or `npm` command, for example
     `npx playwright install`. Say what it does, and run it only when the developer
     agrees.
   - Never: anything that handles the API key. Do not ask for it, read it, write it
     or print it, and do not run `testpilot config set-azure-openai --prompt-api-key`.
     Tell the developer to run that command in their own terminal.

A code that is not in this file means testpilot is newer than this skill: relay the
report as above, say that this file does not cover the code, and point to the log.

## Setup problems (exit 2)

### `INPUT_NOT_FOUND`

**Exit:** 2

**Cause:** the markdown file given to `generate` does not exist.

**Hint:** Check the path of the markdown file: it must exist, relative to the directory testpilot runs in.

**Fix:** check the path with the developer; it is relative to the directory the
command ran in. The run stopped before it started, so there is no stage, step or log.

### `CONFIG_INVALID`

**Exit:** 2

**Cause:** `.testpilot/config.json` cannot be read or is invalid, a `.env` or
`.env.local` file cannot be read or parsed, or a setting or a flag has a value
testpilot does not accept.

**Hint:** The message names the setting and where its value came from (a flag, the environment, a .env file or config.json); fix it there. `testpilot config list` shows every effective setting.

**Fix:** the message names the setting and where its value came from. Recommend
correcting it there (the flag, the environment variable, the `.env` file or
`config.json`). You may run `testpilot config list` to show every effective setting
and where each comes from. Editing `config.json` or a `.env` file is the developer's
call: recommend the change and wait.

**In plain words:** a setting has a value testpilot cannot use, and the message says
which one.

### `API_KEY_IN_CONFIG`

**Exit:** 2

**Cause:** `.testpilot/config.json` contains the API key. testpilot reads the key only
from the environment.

**Hint:** Remove the API key from config.json: the key is only read from the environment. The developer runs `testpilot config set-azure-openai --prompt-api-key` in their own terminal to store it; never type or paste the key on their behalf.

**Fix:** the developer removes the key from `config.json`, then stores it with
`testpilot config set-azure-openai --prompt-api-key` in their own terminal. Do not
open `config.json` to read or edit the key, and do not run that command yourself.

**In plain words:** the key must not sit in the config file; testpilot refuses to run
while it does.

### `LLM_SETTINGS_MISSING`

**Exit:** 2

**Cause:** a required Azure OpenAI setting is not set. The message lists which
(`Missing required TESTPILOT_...`).

**Hint:** Run `testpilot config set-azure-openai` with the missing values (`testpilot config list` shows which are unset). If the API key is missing, the developer runs `testpilot config set-azure-openai --prompt-api-key` in their own terminal.

**Fix:** run `testpilot config list` to see which settings are unset. For the
endpoint, model name, deployment name and API version, ask the developer for the
values and run `testpilot config set-azure-openai` with them. If the API key is the
missing one, tell the developer to run
`testpilot config set-azure-openai --prompt-api-key` in their own terminal.
`references/configuration.md` has the details. The run stopped before the first
stage, so the stage is `null`.

**In plain words:** testpilot does not know which LLM service to use, or has no key
for it yet.

### `LLM_AUTH_FAILED`

**Exit:** 2

**Cause:** the LLM service answered the request with HTTP 401 or 403.

**Hint:** The LLM service refused the API key: it is wrong, expired or has no access to the deployment. The developer re-enters it by running `testpilot config set-azure-openai --prompt-api-key` in their own terminal.

**Fix:** the developer re-enters the key with
`testpilot config set-azure-openai --prompt-api-key` in their own terminal. Do not ask
for the key, and do not run that command yourself. If the developer says the key is right, the message and the log may
say more; quote them, and do not guess.

**In plain words:** the service did not accept the key. The hint lists what it can
mean: wrong, expired, or without access to the deployment.

### `LLM_NOT_FOUND`

**Exit:** 2

**Cause:** the LLM service answered the request with HTTP 404.

**Hint:** The LLM service does not know the endpoint, deployment or API version. Check the endpoint, deployment name and API version with `testpilot config list`.

**Fix:** run `testpilot config list` and go through the endpoint, the deployment name
and the API version with the developer. If one is wrong, recommend the correction;
once they give you the value, `testpilot config set-azure-openai` sets it (never the
key).

**In plain words:** the service does not recognise the address, the deployment or the
API version testpilot used.

### `BROWSER_LAUNCH_FAILED`

**Exit:** 2

**Cause:** Chromium could not be launched, either the agent's browser or the one that
replays the script. testpilot reports it this way when a browser launch failure is
anywhere in the failure's cause chain.

**Hint:** Chromium could not be launched, usually because it is not installed. Run `testpilot doctor`: it prints the install command.

**Fix:** run `testpilot doctor`; it reports the browser check and prints a `fix:`
line, usually `npx playwright install` run in testpilot's own folder. Relay that line.
It is an `npx` command: ask the developer before running it, and say that it
downloads testpilot's Chromium build.

**In plain words:** the browser testpilot needs is probably not installed. The hint
says "usually": `doctor` tells whether that is the case.

### `LOG_DIR_FAILED`

**Exit:** 2

**Cause:** testpilot could not create the log folder `.testpilot/logs/`. The message
has the operating system's reason.

**Hint:** The log folder could not be created. Check the permissions on .testpilot/logs/ and the free disk space.

**Fix:** the developer checks the permissions on `.testpilot/logs/` and the free disk
space. The run stopped before it started, so there is no log.

### `OUTPUT_CONFLICT`

**Exit:** 2

**Cause:** the outputs this run would write already belong to another markdown file
with the same name, in another folder. testpilot names a test case's script and JSON
after the input's file name, so the run would overwrite them. The message names the
JSON and the input it was generated from.

**Hint:** Another markdown file with the same name was generated before, and this run would overwrite its script and test case JSON, which are named after the file. Rename one of the two files; if the other test case is gone, delete the JSON the message names.

**Fix:** the developer renames one of the two markdown files, or, if the other test
case is no longer wanted, deletes the JSON the message names. The run stopped before
it started, so there is no log.

**In plain words:** two test cases have the same file name, and their generated
scripts would end up in the same file.

## Failed runs (exit 1)

### `LLM_UNREACHABLE`

**Exit:** 1

**Cause:** testpilot could not connect to the LLM service: for example a wrong
endpoint host, or no network.

**Hint:** The LLM service could not be reached. Check the endpoint with `testpilot config list` and the network connection, then try again.

**Fix:** run `testpilot config list` and check the endpoint with the developer. If it
is right, a network problem is possible, which may be temporary; recommend trying
again once the connection is back, and wait for their go-ahead.

**In plain words:** the request never reached the service.

### `LLM_RATE_LIMITED`

**Exit:** 1

**Cause:** the LLM service answered with HTTP 429 (too many requests), and it still
did after testpilot retried with a wait in between.

**Hint:** The LLM service is rate limiting the requests, and the retries did not get through. Wait a minute or two and try again.

**Fix:** recommend waiting a minute or two and running `generate` again; wait for the
developer's go-ahead.

**In plain words:** the service asked testpilot to slow down, and the retries did not
get through.

### `LLM_REQUEST_FAILED`

**Exit:** 1

**Cause:** the LLM service rejected or failed a request for a reason other than the
other `LLM_` codes here. The message carries the service's reason.

**Hint:** The LLM service rejected or failed the request; the message carries its reason. If it looks transient, try again.

**Fix:** relay the service's reason from the message as it is. If it looks
transient, recommend trying again and wait for the developer's go-ahead. If the
message does not explain it, say so and point to the log.

### `LLM_RESPONSE_INVALID`

**Exit:** 1

**Cause:** the LLM answered, but its answer was not valid JSON or not the shape
testpilot expects. It happens either in the `structure` stage, or in the `extract`
stage, where the code for each step is judged; a `--json` result's stage says which.

**Hint:** The LLM answered with something that is not the expected JSON. This is usually a one-off: try again.

**Fix:** recommend running `generate` again, and wait for the developer's go-ahead. If
it repeats, point to the log.

**In plain words:** the model gave an answer testpilot could not read.

### `BROWSER_AGENT_FAILED`

**Exit:** 1

**Cause:** the browser agent (Playwright MCP) failed: it could not start, a browser
tool call failed, or it could not reconnect. The message says which.

**Hint:** The browser agent (Playwright MCP) failed to start, to run a tool or to reconnect. Try again; if it repeats, the run log has the MCP error.

**Fix:** recommend running `generate` again, and wait for the developer's go-ahead. If
it repeats, read the log for the MCP error and quote it; do not interpret it. If the
message or the log shows that Chromium could not be launched, the code would be
`BROWSER_LAUNCH_FAILED` instead.

### `STEP_OUT_OF_TURNS`

**Exit:** 1

**Cause:** the browser agent did not finish a step within the turn limit (25 turns per
step unless the developer changed it). The step is `error.step`.

**Hint:** The agent did not finish the step within the turn limit. Split the step into smaller ones, or raise the limit with `--max-turns` (or `maxTurns` in config.json).

**Fix:** recommend one of the two options in the hint: split the step into smaller
ones, or raise the limit with `--max-turns` (or `maxTurns` in `config.json`). Splitting
a step edits the test case, and raising the limit changes a setting: both are the
developer's call, so recommend and wait. See `references/test-case-format.md` for
how to phrase steps.

**In plain words:** the agent was still working on the step when it ran out of turns.
The hint says what to try; the cause of the long step is not in the report, so do not
guess at it.

### `STEP_ABANDONED`

**Exit:** 1

**Cause:** the browser agent stopped without finishing the step. The message carries
its last words, which usually say why.

**Hint:** The agent stopped without finishing the step; the message has its last words, which usually say why. Check the step against the page, and reword it if it is ambiguous.

**Fix:** relay the agent's last words from the message as they are. Recommend that the
developer check the step against the page and reword it if it is ambiguous; you may
suggest wording, but do not change the test case until they agree.

### `STEP_REPORT_INVALID`

**Exit:** 1

**Cause:** the browser agent reported a finished step wrongly: the report was
malformed, or it named a statement it never ran.

**Hint:** The agent reported the step wrongly: a malformed report, or a statement it never ran. This is usually a one-off: try again.

**Fix:** recommend running `generate` again, and wait for the developer's go-ahead. If
it repeats, point to the log.

**In plain words:** the agent's report about a step was not usable.

### `STEP_VALIDATION_FAILED`

**Exit:** 1

**Cause:** a step still failed validation after the run spent its re-extractions (at
most 5 per run). The message has the last failure; `error.step` is the step.

**Hint:** The step still failed validation after the run spent its retries; the message has the last failure. Make the step more specific, or check that the page behaves as the step says.

**Fix:** relay the last failure from the message as it is. Recommend making the step
more specific, or checking that the page behaves as the step says; wait for the
developer's decision, and do not rewrite the step yourself first.

**In plain words:** testpilot tried the step several times and it never passed the
checks; the message says how the last attempt failed.

### `NO_STATEMENTS`

**Exit:** 1

**Cause:** no step produced any Playwright statement, so there is nothing to assemble
into a script. The stage is `generate`.

**Hint:** No step produced any statement, so there is nothing to assemble into a script. Check that the steps describe actions or checks on the page.

**Fix:** recommend that the developer check that the steps describe actions or checks
on the page, as `references/test-case-format.md` explains. The test case is theirs to
change.

### `SCRIPT_ASSEMBLY_FAILED`

**Exit:** 1

**Cause:** in the `generate` stage, the assembled script does not compile, or it
dropped or altered code that had been validated. The message says which.

**Hint:** The generated script does not compile, or dropped or altered validated code. This is usually a one-off, so try again; the validated test case JSON was written to `.testpilot/tests/`.

**Fix:** recommend running `generate` again, and wait for the developer's go-ahead.
The validated test case JSON is already written; in a `--json` result, its path is
`testCase`. Do not write a script from it yourself.

**In plain words:** the steps passed, but testpilot could not turn them into a
correct script.

### `INTERNAL_ERROR`

**Exit:** 1

**Cause:** no other code matched the failure. It can be something testpilot did not
expect, for example a statement that does not parse on its own, or a file-system error
while testpilot reads the test case or writes its output (a permission denied, a full
disk); the message names it.

**Hint:** No specific code matched this failure. If the message names a file-system problem (a permission, a full disk), fix that; otherwise it is likely a testpilot bug: report it with the run log.

**Fix:** relay the report and the log path. If the message names a file-system problem,
recommend that the developer fix it (for example, free disk space or the folder's
permissions). Otherwise recommend that they report it to the testpilot maintainers with
the log. Do not guess at a cause or at a workaround. Whether a re-run helps is not
known; if the developer wants one, it is their call.
