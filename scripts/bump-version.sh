#!/usr/bin/env bash
set -euo pipefail

DATE=$(date +%Y-%m-%d)
CURRENT_FILE="$(dirname "$0")/../VERSION"

if [ -f "$CURRENT_FILE" ]; then
  CURRENT=$(cat "$CURRENT_FILE" | tr -d '[:space:]')
  CURRENT_DATE=$(echo "$CURRENT" | grep -oP '^\d{4}-\d{2}-\d{2}')
  if [ "$CURRENT_DATE" = "$DATE" ]; then
    CURRENT_N=$(echo "$CURRENT" | grep -oP '(?<=build-)\d+' || echo "0")
    NEXT_N=$(( CURRENT_N + 1 ))
  else
    NEXT_N=1
  fi
else
  NEXT_N=1
fi

NEW_VERSION="${DATE}-build-$(printf '%03d' ${NEXT_N})"
echo "$NEW_VERSION" > "$CURRENT_FILE"
echo "Version bumped to: $NEW_VERSION"
