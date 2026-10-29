#!/usr/bin/env bash
# PostToolUse (Write|Edit): format and lint the edited Python file.
# Lint errors Ruff cannot fix are fed back to Claude (exit 2).
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty')
project="${CLAUDE_PROJECT_DIR:-$PWD}"

case "$file" in
  "$project"/*.py) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

cd "$project" || exit 0
uv run --quiet ruff format --quiet "$file"
# F401 stays unfixable here: an import added one edit before its first use
# would otherwise be deleted. The pre-commit check still catches it.
if ! out=$(uv run --quiet ruff check --fix --unfixable F401 --quiet "$file" 2>&1); then
  echo "Ruff found issues in $file:" >&2
  echo "$out" >&2
  exit 2
fi
