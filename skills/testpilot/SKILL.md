---
name: testpilot
description: Generate a Playwright test script from a markdown test case with testpilot. Use when the developer asks to turn a test case, or test steps they give, into a Playwright test ("generate a Playwright test from this test case", "make an e2e test of these steps"); to set testpilot up in a project or fix its setup (doctor, init, Azure OpenAI settings); or to explain why a testpilot run failed.
---

# testpilot

testpilot turns a markdown test case into a Playwright test script: an LLM agent
performs each step in a real browser, the code it ran is replayed and checked, and the
checked code becomes a spec. You drive it with the `testpilot` command, run from the
project root (the folder with `package.json`).

## The usual flow

1. If you are unsure of the setup (the first run in this project, or a setup error),
   run `testpilot doctor` and relay what it reports (rule 6).
2. Get the test case (rules 1 to 3): the developer's markdown file, or the steps they
   wrote, which you put in a file following
   [references/test-case-format.md](references/test-case-format.md).
3. Run `testpilot generate <path.md> --json` and wait for it to finish, as
   "Waiting for `generate`" below says.
4. On success, report the `spec` path, plus the `testCase` and `log` paths, and stop:
   do not run the spec. On failure, follow [references/errors.md](references/errors.md).

## Waiting for `generate`

A run takes minutes. While it runs, a progress line goes to stderr at least every 15
seconds (`Waiting for <stage> to finish: step <i> of <n>, "<step>" (<s>s)`, the step
part only while a step is extracted): it is working, not stuck.

- Run it once, in the foreground, as a normal command (not a background one). If
  your terminal tool takes a timeout, give it a long one (30 minutes or more).
- Your terminal tool may return before the command has exited: with no exit code,
  with a timeout, with a note that the command moved to the background, or with a
  note that it "may be waiting for input". The run is still going; `generate` never
  asks for input. Keep waiting on that same terminal until the command exits and the
  JSON is printed (in VS Code, call `get_terminal_output` with the terminal id the
  result gave you, or wait for its notification that the command finished).
- While `generate` runs, run no other terminal command at all, not even to check on
  it. In VS Code, a new command goes to the busy terminal and first sends Ctrl+C,
  which kills the run. To look at the log, or at a file your tool saved the output
  to, open it with your file-reading tool.
- Never start a second `generate` while one is running, and never stop a run because
  it is slow.
- It has finished when the command exits. Its stdout holds only the JSON object,
  printed last, after the progress lines: read `status`, `exitCode`, `spec`,
  `testCase`, `log` and `error` from it. If it exits with no JSON object (a usage
  error, such as a mistyped flag), the error is on stderr: relay it.

## Hard rules

These are the developer's decisions. Follow them exactly.

1. **The developer brings the test.** Use their markdown file, or turn the steps they
   wrote in the prompt into a file following `test-case-format.md`. A vague request
   ("write me a test for the login flow") is not enough: ask for the actual steps.
   Never make steps up.
2. **You may explore the site to sharpen the steps.** With your own browser tools
   (testpilot provides none for this), look up the exact label of a button, the exact
   text of a message, or a URL the developer left out. Refine their steps; do not add
   new ones. A small wording fix you can just make. When what you find changes a
   step's meaning (a different flow, an extra step), show the developer the revised
   test case before you run `generate`.
3. **Save a new test case where the project keeps them.** Look for a folder that
   already holds testpilot test cases (by content: `.md` files with a title, a
   `urls = [...]` line and a `## Steps` list) and save it there. If there are
   several, ask which. If there is none, create `.testpilot/input/` and save it there.
4. **Generate.** Run `testpilot doctor` when unsure of the setup, then
   `testpilot generate <path.md> --json`, wait for it to finish (see "Waiting for
   `generate`"), and report the spec path.
5. **On a failure: report, recommend, let the developer decide.** Relay testpilot's
   report as fully as you can: the error code, the stage, the failing step,
   testpilot's message, the hint and the log path. You may explain it in plainer
   words, but only from testpilot's report and what `errors.md` says about that code.
   If neither explains the cause, say so and point to the log. Never guess at a cause
   testpilot did not report. When there is a concrete fix, recommend it; then wait.
   Never edit the test case or the settings and re-run on your own. This holds for a
   plain re-run too: when the hint is only "try again", say so and wait for the
   developer's go-ahead.
6. **Setup problems work the same way.** Relay `doctor`'s failures and warnings with
   their `fix:` lines.
    - Run freely: `testpilot doctor`, `testpilot config list`, `testpilot init`
      (without `--skills`), and `testpilot config set-azure-openai` with values the
      developer gave you that are not secret.
    - Ask first, every time: every `npx` and `npm` command (`npx playwright install`,
      `npm install`, `npm init playwright@latest`, and
      `npm install -D @playwright/test@<version>` only when `doctor` warns that the
      project's Playwright is older than testpilot's). Say what it does; run it only
      when the developer agrees. The same for `testpilot init --skills ...`: it
      replaces the installed skill folder, hand edits included, and with `-g` writes
      to the developer's home folder.
    - Never: anything that handles the API key (rule 7).
7. **The API key is never yours.** Never ask for it, read it, write it or print it,
   and never run `testpilot config set-azure-openai --prompt-api-key`. Your terminal
   is a real one, so testpilot cannot stop you: this rule does. Tell the developer to
   run that command in their own terminal.
8. **The log.** You may read the run's log to quote the relevant lines to the
   developer. Quote; do not interpret beyond what is there.

## References

Read each when you need it:

- [references/test-case-format.md](references/test-case-format.md): before you write
  a test case file or check one, and for where a new file goes.
- [references/commands.md](references/commands.md): what each `testpilot` command is
  for and when to run it. For flags, run `testpilot <command> --help`.
- [references/configuration.md](references/configuration.md): when a setting is
  missing or wrong, or to set Azure OpenAI up.
- [references/errors.md](references/errors.md): when `generate` fails, before you
  tell the developer what went wrong.
