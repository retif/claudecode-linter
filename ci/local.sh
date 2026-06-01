#!/usr/bin/env bash
# ci/local.sh — canonical local-parity entrypoint for claudecode-linter.
# One command to reproduce the Woodpecker npm publish on emmett. The CI YAML and
# this script call the SAME ci/stage.sh + ci/publish.sh, so they cannot drift.
# See oleks/emmett#44 (Local Pipeline Parity), archetype: npm-library.
#
# DEFAULT = DRY RUN: builds, tests and `npm pack`s the artifact into the local
# store, then prints exactly what WOULD be published. NO registry contact.
# Pass --publish (or PUBLISH=1) to actually push to the Gitea npm registry.
#
#   ci/local.sh                 # dry-run: stage only, show plan
#   ci/local.sh --publish       # stage + publish to git.oleks.space npm
#   VERSION=2.1.150 ci/local.sh --publish
#
# This script never prints the token and never enables set -x.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# shellcheck source=ci/common.sh
. ci/common.sh

DO_PUBLISH=0
[ "${PUBLISH:-0}" = "1" ] && DO_PUBLISH=1
for arg in "$@"; do
  case "$arg" in
    --publish)      DO_PUBLISH=1 ;;
    --dry-run)      DO_PUBLISH=0 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

TAG="$(resolve_version)"

# 1. STAGE (always — cluster-independent build half)
bash ci/stage.sh

TARBALL="$(cat "$STAGE_DIR/.last-tarball")"

if [ "$DO_PUBLISH" -ne 1 ]; then
  cat <<EOF

DRY RUN (default). Nothing was published.
  package : $(node -e "process.stdout.write(require('./package.json').name)")@$TAG
  artifact: $TARBALL
  target  : $NPM_REGISTRY  (PUT, dist-tag 'latest' -> $TAG)
Re-run with --publish (or PUBLISH=1) to push to the registry.
EOF
  exit 0
fi

# 2. PUBLISH (registry half — only with explicit opt-in)
bash ci/publish.sh
echo "==> done: $TAG published to $NPM_REGISTRY"
