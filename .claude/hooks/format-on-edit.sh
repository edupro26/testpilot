#!/usr/bin/env bash
# PostToolUse (Write|Edit): format and lint the edited TypeScript file.
# Lint errors ESLint cannot fix are fed back to Claude (exit 2).
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty')
project="${CLAUDE_PROJECT_DIR:-$PWD}"

case "$file" in
  "$project"/node_modules/*) exit 0 ;;
  "$project"/*.ts) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

cd "$project" || exit 0
npx --no-install prettier --log-level warn --write "$file"
# Unused imports stay errors rather than being fixed away: an import added one
# edit before its first use would otherwise be deleted. The pre-commit check
# still catches them.
if ! out=$(npx --no-install eslint --fix "$file" 2>&1); then
  echo "ESLint found issues in $file:" >&2
  echo "$out" >&2
  exit 2
fi
