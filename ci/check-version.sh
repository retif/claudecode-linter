#!/usr/bin/env bash
# Woodpecker step: check-version (release.yml).
# Exits 78 (Woodpecker's "skip" code) if already up to date.
set -e

npm ci
CURRENT=$(node -e "const d = require('./contracts/claude-code-contracts.json'); console.log(d.version)")
LATEST=$(npm view @anthropic-ai/claude-code version)
echo "Current: $CURRENT"
echo "Latest:  $LATEST"
if [ "$CURRENT" = "$LATEST" ]; then
  echo "Already up to date — nothing to do."
  exit 78
fi
echo "$LATEST" > .claude-code-version
echo "Will update to v$LATEST"
