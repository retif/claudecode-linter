#!/usr/bin/env bash
# ci/common.sh — shared helpers for claudecode-linter local-parity pipeline.
# Sourced by ci/stage.sh, ci/publish.sh and ci/local.sh. See oleks/emmett#44
# (Local Pipeline Parity), archetype: npm-library.
#
# Provides:
#   resolve_version   -> echoes the TAG (no leading v), identical in CI + local
#   resolve_token     -> echoes the registry token (NEVER logged; never under set -x)
#   require_dev_guard -> refuses a floating publish unless CI_COMMIT_TAG=^v or VERSION set
#   registry url/owner constants
#
# Inputs (env, all optional):
#   VERSION          explicit tag override (local dev convenience)
#   CI_COMMIT_TAG    set by Woodpecker on tag events; "vX.Y.Z" -> "X.Y.Z"
#   REGISTRY_TOKEN   Gitea PAT with package read/write (CI: from_secret)
#
# This file is sourced, not executed; it must not enable `set -x` — the token
# resolution would otherwise leak the secret into the build log.
set -euo pipefail

REGISTRY_HOST="${REGISTRY_HOST:-git.oleks.space}"
REGISTRY_OWNER="${REGISTRY_OWNER:-oleks}"
NPM_REGISTRY="https://${REGISTRY_HOST}/api/packages/${REGISTRY_OWNER}/npm"

# Local on-disk artifact store (STAGE output). NO registry contact to produce it.
STAGE_DIR="${STAGE_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.stage}"

# --- VERSION/TAG: derived identically for CI + local -------------------------
# package.json is the source of truth for this repo's version (it tracks the
# Claude Code release). $VERSION overrides; a v-prefixed $CI_COMMIT_TAG is stripped.
resolve_version() {
  if [ -n "${VERSION:-}" ]; then
    printf '%s\n' "$VERSION"
  elif [ -n "${CI_COMMIT_TAG:-}" ]; then
    printf '%s\n' "${CI_COMMIT_TAG#v}"
  else
    node -e "process.stdout.write(require('./package.json').version)"
    printf '\n'
  fi
}

# --- TOKEN: $REGISTRY_TOKEN -> pass -> named hard-fail -----------------------
# IMPORTANT: never echo/print the returned value; never call under set -x.
resolve_token() {
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    printf '%s' "$REGISTRY_TOKEN"
    return 0
  fi
  if command -v pass >/dev/null 2>&1; then
    local t
    t="$(pass infra/gitea/personal_access_token_packages_rw 2>/dev/null || true)"
    if [ -n "$t" ]; then
      printf '%s' "$t"
      return 0
    fi
  fi
  echo "ERROR: no registry token. Set \$REGISTRY_TOKEN or store it at" >&2
  echo "       pass infra/gitea/personal_access_token_packages_rw" >&2
  return 1
}

# --- DEV-TAG GUARD -----------------------------------------------------------
# Publishing moves the npm 'latest' dist-tag, so refuse a publish from a floating
# local run unless this is an explicit tagged release (CI_COMMIT_TAG=^v) or the
# operator pinned VERSION on purpose.
require_dev_guard() {
  if [ -n "${VERSION:-}" ]; then return 0; fi
  case "${CI_COMMIT_TAG:-}" in
    v*) return 0 ;;
  esac
  echo "ERROR: refusing to publish (would move npm 'latest' dist-tag)." >&2
  echo "       Set VERSION=X.Y.Z or run on a vX.Y.Z tag (CI_COMMIT_TAG) to publish." >&2
  return 1
}

# --- PREFLIGHT: name the blocker --------------------------------------------
preflight_registry() {
  if ! curl -sf -o /dev/null --max-time 10 "https://${REGISTRY_HOST}/api/v1/version"; then
    echo "ERROR: registry ${REGISTRY_HOST} unreachable (cluster down?)." >&2
    echo "       BUILD/STAGE works offline; PUBLISH needs the registry — retry later." >&2
    return 1
  fi
}
