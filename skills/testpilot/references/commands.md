# Commands

Read this to know what each `testpilot` command is for and when to run it. This file
does not list flags: for the exact flags of a command, run
`testpilot <command> --help` (`testpilot --help` lists the commands). The help comes
from the installed testpilot, so it is always current.

## Running a command

- Run testpilot from the project root, the folder with `package.json`. A path you
  give it, such as the test case's, is relative to the folder the command runs in.
- If the shell says `testpilot` is not found, testpilot is not installed on this
  machine. Tell the developer; its README's Setup section says how to install it. Do
  not install it yourself.
- Every command exits with `0` on success, `1` when the test case failed to generate,
  and `2` for a setup, usage or configuration error.
- Results go to stdout; progress and log lines go to stderr.

## What you may run

| Command | You |
|---|---|
| `testpilot doctor` | run it freely |
| `testpilot config list` | run it freely |
| `testpilot init` (without `--skills`) | run it freely |
| `testpilot config set-azure-openai` | run it freely, with values the developer gave you that are not secret |
| `testpilot generate` | run it as the usual flow in `SKILL.md` says; after a failure, run it again only when the developer agrees |
| every `npx` and `npm` command | ask first, every time: say what it does, run it only when the developer agrees |
| `testpilot init --skills ...` | ask first: it replaces the installed skill folder, hand edits included, and with `-g` writes to the developer's home folder |
| `testpilot config set-azure-openai --prompt-api-key` | never: tell the developer to run it in their own terminal |

`doctor` and `config list` only read. `init` without `--skills` is safe to run
again: it only adds what is missing and never replaces a value already set. The `npx`
and `npm` commands are the ones `doctor` prints as fixes: `npx playwright install`,
`npm install`, `npm init playwright@latest`, and
`npm install -D @playwright/test@<version>` (only when `doctor` warns that the
project's Playwright is older than testpilot's). They download or install software,
so they are the developer's call.

## `testpilot doctor`

Checks that testpilot and this project are set up: the Node.js version, that
testpilot's own Chromium build launches, that the project has `@playwright/test`
and that it is not older than testpilot's, that the project has a
`playwright.config.*`, and that the LLM settings are complete and valid. It also
checks every installed copy of this skill against the installed testpilot.

Run it when you are unsure of the setup: before the first `generate` in a project,
after a setup error (exit `2`), and after the developer says they fixed something.

It prints one line per check: `✔` passed, `!` a warning, `✖` a failure. Under each
warning and failure is a `fix:` line with the command to run or what to change. It
exits `2` if any check failed; warnings alone exit `0`.

Relay every failure and warning to the developer with its `fix:` line, as printed.
Then act on each fix as the table above says:

- An `npx` or `npm` command (Chromium is missing, the project's Playwright is
  missing or older than testpilot's, there is no Playwright config): ask first. The
  Chromium fix runs `npx playwright install` in testpilot's own folder: it downloads
  testpilot's Chromium build into the shared Playwright cache.
- The LLM settings: see `configuration.md`.
- An out-of-date copy of this skill (`! Skill: <path> is outdated`): the fix is a
  `testpilot init --skills ...` command. It replaces that copy entirely, including
  any change the developer made to it by hand, so say so and run it when the
  developer agrees.

## `testpilot init`

Sets testpilot up in this project. It runs the same checks as `doctor` and prints
them. If they pass (the LLM settings may still be missing), it creates `.testpilot/`
with `config.json` (holding `scriptsDir`, the folder generated scripts go to, read
from the project's Playwright `testDir`) and a `.gitignore` for the files testpilot
writes as it runs. It only adds what is missing: an existing `.gitignore` is kept,
and an existing `config.json` keeps every key, `scriptsDir` included if already set
(when it is not, `init` adds it). If a check other than the LLM settings fails, it
does not create `.testpilot/` and exits `2`: relay the failures as for `doctor`, and
run `init` again once the developer has fixed them.

Run it when the project has no `.testpilot/` folder yet. That happens when this skill
was installed before the project was set up: with `testpilot init --skills -g`,
which installs the skill in the developer's home folder only, or with
`testpilot init --skills` whose checks failed.

With `--skills`, `init` also installs this skill, or updates it, in the folder of the
agent named by its value, replacing that skill folder entirely, hand edits
included; with `-g` it installs the user copy only, in the developer's home folder,
and does not check or set up the project. Install or update the skill only when the
developer asks or agrees.

## `testpilot config list`

Prints every effective setting, one per line: its name, its value and, in
parentheses, where the value came from (`default`, `config.json`, `.env`,
`.env.local`, `environment` or `flag`). A setting with no value shows `(not set)`.
The API key shows masked. When the configuration is invalid it prints no list: it
exits `2` with an `Invalid configuration:` error on stderr that names the setting and
where its value came from. Relay it; the fix belongs in that source.

Run it to see which LLM settings are missing, to check a value the developer asks
about, and to see which source a value comes from when a change does not take effect.
For the API key, say only whether it is set; do not repeat even its masked value.
`configuration.md` explains the settings and the sources.

## `testpilot config set-azure-openai`

Writes the Azure OpenAI settings that are not secret to `.testpilot/config.json`:
the endpoint, the model name, the deployment name and the API version. Each value
given overwrites the stored one; the others are kept. It prints the files it updated.
It warns when a value it wrote does not take effect because a stronger source (a
`.env.local` file, the shell environment) still sets it: relay the warning.

Run it with values the developer gave you, when settings are missing or wrong. Do not
guess a value or take one from elsewhere in the project without asking the developer.
See `testpilot config set-azure-openai --help` for the flags. Do not pass `--save`
unless the developer asks for it: it also writes the values to a dotenv file
(`.env.local` by default), which may hold the API key.

The API key is never a flag. `testpilot config set-azure-openai --prompt-api-key`
asks for it with hidden input: never run it yourself. Tell the developer to run that
command in their own terminal. `configuration.md` has the details.

## `testpilot generate`

Turns one markdown test case into a Playwright script. It writes the script to the
scripts folder (`scriptsDir`), the validated test case JSON to `.testpilot/tests/`,
and a log of the run to `.testpilot/logs/`, all named after the input file.

Always run it as `testpilot generate <path.md> --json`: `--json` prints the result as
one JSON object on stdout, for a success and a failure alike, which you read once the
command has finished. `SKILL.md` says how to wait for it, and `errors.md` how to read
a failure. Other flags change one run without changing the settings (for example to
show the browser, or a different turn limit): use one when the developer asks for it,
or when they agree to a fix that needs it, and check its name with
`testpilot generate --help`.

Before running it, make sure the test case follows `test-case-format.md`. After a
success, report the paths and stop: do not run the generated spec.
