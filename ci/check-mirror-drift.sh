#!/usr/bin/env bash
# ci/check-mirror-drift.sh — detect commits that exist on one remote but not the
# other, i.e. merged work that no release pipeline can see (oleks/claudecode-linter#19).
#
# WHY THIS EXISTS
# This repo has two remotes and the npmjs release pipelines only see ONE of them:
#
#   gitea  = git.oleks.space/oleks/claudecode-linter   (private; where PRs merge)
#   github = github.com/retif/claudecode-linter        (public;  where npmjs releases are cut from)
#
# `.github/workflows/{release,patch-release}.yml` both check out GITHUB and publish
# to npmjs.org. Nothing pushes gitea main -> github main. So a PR merged on Gitea is
# invisible to every pipeline that could ship it — with no error, no warning and no
# stale marker. Three fixes (#12, #13, #14) sat inert this way while
# `claudecode-linter --version` reported a correct, useless answer.
#
# See docs/RELEASING.md for the full delivery path.
#
# WHAT IT DOES
# Compares the two `main` tips in BOTH directions and reports the commits that are
# on one side only, with the AGE of the oldest such commit. Drift immediately after
# a merge is normal and transient; drift that has SAT for a long time is the bug.
# So it fails only once the oldest unmirrored commit is older than MAX_DRIFT_HOURS.
#
# Inputs (env, all optional):
#   MAX_DRIFT_HOURS  fail threshold in hours (default 24; 0 = fail on any drift)
#   GITHUB_URL       override the GitHub upstream (default: package.json repository.url)
#   GITEA_REMOTE     local remote name for the Gitea side (default: gitea)
#
# Exit codes:
#   0  in sync, or drift younger than the threshold
#   1  drift older than the threshold  (the actionable failure)
#   2  could not determine the answer  (never pass vacuously — see below)
#
# Exit 2 matters: a check that cannot compute its answer must NOT report success.
# A shallow CI clone has no common history, so ancestry queries fail; that is
# reported as "unknown", not "clean".
set -euo pipefail

MAX_DRIFT_HOURS="${MAX_DRIFT_HOURS:-24}"
GITEA_REMOTE="${GITEA_REMOTE:-gitea}"

die_unknown() {
  echo "‼ mirror-drift: CANNOT DETERMINE — $*" >&2
  echo "  Refusing to report success without an answer." >&2
  exit 2
}

# --- Resolve the GitHub upstream from package.json (single source of truth) ---
if [ -z "${GITHUB_URL:-}" ]; then
  GITHUB_URL="$(node -e "
    const r = require('./package.json').repository;
    const u = (typeof r === 'string' ? r : r && r.url) || '';
    process.stdout.write(u.replace(/^git\+/, '').replace(/\.git$/, ''));
  " 2>/dev/null || true)"
fi
[ -n "$GITHUB_URL" ] || die_unknown "no GitHub upstream in package.json 'repository.url' and \$GITHUB_URL unset"

echo "▸ github upstream : $GITHUB_URL"

# --- Resolve the two main tips ------------------------------------------------
# GitHub side: always fetched fresh over https. The repo is public, so this needs
# no credentials — which is precisely why the check can run from the Gitea side.
git fetch --quiet "$GITHUB_URL" main 2>/dev/null \
  || die_unknown "could not fetch main from $GITHUB_URL (network? repo renamed?)"
GH_TIP="$(git rev-parse FETCH_HEAD)"

# Gitea side: in CI we are already checked out on it, so HEAD is authoritative and
# needs no token. Locally, read the configured remote.
if [ -n "${CI:-}" ]; then
  GT_TIP="$(git rev-parse HEAD)"
  echo "▸ gitea tip       : $GT_TIP (CI checkout HEAD)"
else
  git remote get-url "$GITEA_REMOTE" >/dev/null 2>&1 \
    || die_unknown "no '$GITEA_REMOTE' remote configured (set \$GITEA_REMOTE)"
  git fetch --quiet "$GITEA_REMOTE" main 2>/dev/null \
    || die_unknown "could not fetch main from remote '$GITEA_REMOTE'"
  GT_TIP="$(git rev-parse FETCH_HEAD)"
  echo "▸ gitea tip       : $GT_TIP (remote '$GITEA_REMOTE')"
fi
echo "▸ github tip      : $GH_TIP"

# A shallow clone cannot answer ancestry questions. Say so rather than guessing.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  git fetch --quiet --unshallow 2>/dev/null \
    || die_unknown "shallow clone and could not unshallow — ancestry is not computable (set clone depth to 0)"
fi

# --- Compare both directions --------------------------------------------------
only_on_gitea="$(git rev-list --count "$GH_TIP..$GT_TIP" 2>/dev/null)" \
  || die_unknown "no common history between the two tips — diverged or unrelated histories"
only_on_github="$(git rev-list --count "$GT_TIP..$GH_TIP" 2>/dev/null)" \
  || die_unknown "no common history between the two tips — diverged or unrelated histories"

if [ "$only_on_gitea" -eq 0 ] && [ "$only_on_github" -eq 0 ]; then
  echo "✔ mirror-drift: in sync — gitea main and github main are the same commit."
  exit 0
fi

now="$(date +%s)"
worst_age_h=0

report_side() {
  local range="$1" count="$2" label="$3" consequence="$4"
  [ "$count" -gt 0 ] || return 0

  # Oldest commit in the range decides the age: that is how long the drift has sat.
  local oldest_ts age_h
  oldest_ts="$(git rev-list --reverse --format=%ct "$range" | sed -n '2p')"
  age_h=$(( (now - oldest_ts) / 3600 ))
  [ "$age_h" -gt "$worst_age_h" ] && worst_age_h="$age_h"

  echo
  echo "  $count commit(s) only on $label — oldest has sat ${age_h}h:"
  git log --oneline --no-decorate -n 10 "$range" | sed 's/^/    /'
  [ "$count" -gt 10 ] && echo "    … and $((count - 10)) more"
  echo "  → $consequence"
}

echo
echo "✖ mirror-drift DETECTED"
report_side "$GH_TIP..$GT_TIP" "$only_on_gitea" "gitea" \
  "these are merged but CANNOT be released — npmjs releases are cut from GitHub.
    Fix: git push origin gitea/main:main   (see docs/RELEASING.md — this publishes a
    private repo's commits to a public one, so it stays a human decision)"
report_side "$GT_TIP..$GH_TIP" "$only_on_github" "github" \
  "release-pipeline commits (version bumps, tags) not mirrored back to gitea.
    Fix: git push gitea origin/main:main"

echo
if [ "$MAX_DRIFT_HOURS" -eq 0 ] || [ "$worst_age_h" -ge "$MAX_DRIFT_HOURS" ]; then
  echo "✖ FAILING: oldest drift is ${worst_age_h}h, threshold is ${MAX_DRIFT_HOURS}h." >&2
  echo "  A merged fix that cannot reach a release is the failure this check exists for." >&2
  exit 1
fi

echo "✔ PASSING for now: oldest drift is ${worst_age_h}h, under the ${MAX_DRIFT_HOURS}h threshold."
echo "  Drift right after a merge is expected — release it and this clears."
exit 0
