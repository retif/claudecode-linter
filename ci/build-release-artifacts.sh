#!/usr/bin/env bash
# Woodpecker step: build (release.yml).
# Requires: .claude-code-version (written by ci/check-version.sh).
set -e

VERSION=$(cat .claude-code-version)
echo "Extracting contracts for Claude Code v$VERSION..."
npx tsx scripts/extract-contracts.ts --changelog
npx tsx scripts/extract-plugin-schema.ts
npx tsx scripts/generate-contracts.ts
# gitea#6: fetch schemastore.org schemas alongside Zod extraction so
# the linter ships with both runtime-truth and curated copies (the
# latter is used as the sole source for marketplace + keybindings).
npx tsx scripts/fetch-schemastore.ts
npm run build
npm test
