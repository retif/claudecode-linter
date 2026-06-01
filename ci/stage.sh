#!/usr/bin/env bash
# ci/stage.sh — BUILD-parity half: produce the npm tarball into a local on-disk
# store with NO registry contact. Cluster-independent; always runnable on emmett.
# Shared by .woodpecker/release.yml (CI) and ci/local.sh. See oleks/emmett#44
# (Local Pipeline Parity), archetype: npm-library.
#
# Output: $STAGE_DIR/<name>-<version>.tgz  (the exact artifact PUBLISH replays)
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# shellcheck source=ci/common.sh
. ci/common.sh

usage() { echo "usage: ci/stage.sh [--help]   (env: VERSION, CI_COMMIT_TAG)"; }
case "${1:-}" in --help|-h) usage; exit 0 ;; esac

TAG="$(resolve_version)"
echo "==> stage: claudecode-linter $TAG"

# 1. deps + build (tsc -> dist/) + test. All offline-capable.
if [ ! -d node_modules ]; then
  npm ci
fi
npm run build
npm test

# 2. ensure package.json version matches the resolved TAG so the packed tarball
#    carries the intended version (CI sets this from the synced Claude Code ver).
CUR="$(node -e "process.stdout.write(require('./package.json').version)")"
if [ "$CUR" != "$TAG" ]; then
  echo "==> aligning package.json version $CUR -> $TAG"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    p.version = process.argv[1];
    fs.writeFileSync('package.json', JSON.stringify(p, null, '\t') + '\n');
  " "$TAG"
fi

# 3. pack into the local store (NO registry contact). --ignore-scripts: build
#    already ran; avoid prepublishOnly double-build.
mkdir -p "$STAGE_DIR"
TARBALL_NAME="$(npm pack --ignore-scripts --silent)"
mv -f "$TARBALL_NAME" "$STAGE_DIR/$TARBALL_NAME"

echo "==> staged: $STAGE_DIR/$TARBALL_NAME"
printf '%s\n' "$STAGE_DIR/$TARBALL_NAME" > "$STAGE_DIR/.last-tarball"
