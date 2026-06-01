#!/usr/bin/env bash
# ci/publish.sh — PUBLISH-parity half: replay the already-staged npm tarball to
# the Gitea npm registry. This is the ONLY registry-touching step; it does NOT
# build (so it can replay once the cluster/registry returns). Cluster-co-located
# registry => this half is intentionally NOT cluster-independent.
# Shared by .woodpecker/release.yml (CI) and ci/local.sh. See oleks/emmett#44
# (Local Pipeline Parity), archetype: npm-library.
#
# Reuses $STAGE_DIR/.last-tarball from ci/stage.sh. Must run ci/stage.sh first.
# This script handles the token; it MUST NOT run under set -x.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# shellcheck source=ci/common.sh
. ci/common.sh

usage() { echo "usage: ci/publish.sh [--help]   (env: VERSION, CI_COMMIT_TAG, REGISTRY_TOKEN)"; }
case "${1:-}" in --help|-h) usage; exit 0 ;; esac

TAG="$(resolve_version)"

# guard against clobbering 'latest' from a floating local run
require_dev_guard

# locate the staged artifact
if [ ! -f "$STAGE_DIR/.last-tarball" ]; then
  echo "ERROR: nothing staged. Run ci/stage.sh first." >&2
  exit 1
fi
TARBALL="$(cat "$STAGE_DIR/.last-tarball")"
if [ ! -f "$TARBALL" ]; then
  echo "ERROR: staged tarball missing: $TARBALL" >&2
  exit 1
fi
TARBALL_FILE="$(basename "$TARBALL")"

preflight_registry

PKG_NAME="$(node -e "process.stdout.write(require('./package.json').name)")"
echo "==> publishing $TARBALL_FILE -> $NPM_REGISTRY ($PKG_NAME@$TAG)"

# Resolve token last, into a local, and feed it to curl via env so it never
# appears on a command line or in xtrace. (No `set -x` anywhere in this script.)
TOKEN="$(resolve_token)"

# Build the Gitea-npm PUT body (tarball as base64 _attachment) identically to
# the old inline YAML logic, then PUT. The npm registry endpoint is idempotent:
# re-PUTting an existing version returns 409, which we treat as "already there".
HTTP_CODE="$(
  node -e "
    const fs = require('fs');
    const crypto = require('crypto');
    const pkg = require('./package.json');
    const tarballPath = process.argv[1];
    const registry = process.argv[2];
    const tarballFile = process.argv[3];
    const tarball = fs.readFileSync(tarballPath);
    const shasum = crypto.createHash('sha1').update(tarball).digest('hex');
    const integrity = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64');
    const body = {
      _id: pkg.name,
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg,
          _id: pkg.name + '@' + pkg.version,
          dist: { shasum, integrity, tarball: registry + '/' + pkg.name + '/-/' + tarballFile }
        }
      },
      _attachments: {
        [tarballFile]: {
          content_type: 'application/octet-stream',
          data: tarball.toString('base64'),
          length: tarball.length
        }
      }
    };
    process.stdout.write(JSON.stringify(body));
  " "$TARBALL" "$NPM_REGISTRY" "$TARBALL_FILE" \
  | TOKEN="$TOKEN" curl -s -o /dev/null -w '%{http_code}' -X PUT \
      -H "Authorization: token $TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "$NPM_REGISTRY/$PKG_NAME"
)"
unset TOKEN

case "$HTTP_CODE" in
  2*)   echo "==> published $PKG_NAME@$TAG (HTTP $HTTP_CODE)" ;;
  409)  echo "==> $PKG_NAME@$TAG already published (HTTP 409) — idempotent, ok" ;;
  *)    echo "ERROR: publish failed (HTTP $HTTP_CODE)" >&2; exit 1 ;;
esac
