#!/usr/bin/env bash
# PreToolUse (Bash, git commit only): block the commit unless type-check, lint,
# format and the test suite pass, as AGENTS.md requires.
set -uo pipefail

# The settings' `if` filter is not applied on every version, so check here too:
# any other command passes straight through. The input is read with Node, which
# the project needs anyway; input that cannot be read blocks the commit rather
# than skipping the checks.
if ! command=$(node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    process.stdout.write(JSON.parse(input).tool_input?.command ?? "");
  });
' 2>/dev/null); then
  echo "Commit blocked: could not read the hook input with node." >&2
  exit 2
fi
case "$command" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0

if ! out=$(npm run --silent check 2>&1); then
  echo "Commit blocked: type-check, lint, format or tests are failing. Fix them first." >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
