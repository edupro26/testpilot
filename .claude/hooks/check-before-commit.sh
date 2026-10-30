#!/usr/bin/env bash
# PreToolUse (Bash, git commit only): block the commit unless type-check, lint,
# format and the test suite pass, as AGENTS.md requires.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0

if ! out=$(npm run --silent check 2>&1); then
  echo "Commit blocked: type-check, lint, format or tests are failing. Fix them first." >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
