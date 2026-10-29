#!/usr/bin/env bash
# PreToolUse (Bash, git commit only): block the commit unless lint, format
# and the test suite pass, as AGENTS.md requires.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0

if ! out=$(uv run --quiet ruff check . 2>&1 \
  && uv run --quiet ruff format --check . 2>&1 \
  && uv run --quiet pytest -q 2>&1); then
  echo "Commit blocked: lint, format or tests are failing. Fix them first." >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
