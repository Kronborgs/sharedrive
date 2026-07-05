#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_FILE="$ROOT_DIR/frontend/src/changelog.generated.ts"
COUNT="${1:-20}"

cd "$ROOT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "git not found; skipping changelog generation"
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not inside a git repository; skipping changelog generation"
  exit 0
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

git log -n "$COUNT" --date=format:'%d.%m.%Y' --pretty=format:'%h|%ad|%s' > "$TMP_FILE"

{
  echo "export type ChangelogEntry = {"
  echo "  hash: string"
  echo "  date: string"
  echo "  message: string"
  echo "}"
  echo ""
  echo "export const CHANGELOG_ENTRIES: ChangelogEntry[] = ["

  while IFS='|' read -r hash date message; do
    [ -z "$hash" ] && continue
    esc_message=$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/\"/\\\"/g')
    echo "  { hash: '$hash', date: '$date', message: \"$esc_message\" },"
  done < "$TMP_FILE"

  echo "]"
} > "$OUT_FILE"

echo "Changelog generated: $OUT_FILE"
