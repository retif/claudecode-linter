#!/usr/bin/env bash
# ci/mirror-sync.sh — fast-forward gitea main to github main, and nothing else
# (oleks/claudecode-linter#47, option 1 of #38).
#
# WHY THIS EXISTS
# Two things commit to github main server-side with nobody pushing: dependabot's
# merges and release.yml's own `release: sync with Claude Code vX.Y.Z` bump. Each
# leaves gitea main a strict ancestor of github main until someone runs
#   git merge --ff-only origin/main && git push gitea main
# by hand. That is safe and mechanical, so a scheduled job owns it.
#
# DIRECTION: github -> gitea ONLY. The reverse publishes a private repo's commits
# to a public one and stays a human decision (#19, docs/RELEASING.md). Per the
# operator decision on #47, GitHub Actions never holds a gitea credential; this
# runs on the gitea side (Woodpecker), reading the public GitHub repo anonymously.
#
# CONTRACT — this pushes to `main` unattended, so it fails CLOSED:
#   it pushes ONLY when `git merge-base --is-ancestor <gitea> <github>` positively
#   proves gitea is strictly behind, and every uncertainty is a refusal, never
#   "nothing to do". It never forces: a plain push, so the server itself rejects
#   anything that stopped being a fast-forward between the check and the push.
#
# Usage:
#   bash ci/mirror-sync.sh           # dry run (default): report what it would do
#   bash ci/mirror-sync.sh --apply   # push when, and only when, it is a fast-forward
#
# Inputs (env, all optional):
#   GITHUB_URL     the GitHub upstream (default: package.json repository.url)
#   GITEA_URL      gitea repo to read AND push (default: in CI, $CI_REPO_CLONE_URL
#                  with $REGISTRY_TOKEN; locally, the URL of remote $GITEA_REMOTE)
#   GITEA_REMOTE   local remote name used when GITEA_URL is unset (default: gitea)
#
# Exit codes (same contract as ci/check-mirror-drift.sh):
#   0  in sync, fast-forwarded (--apply), or a fast-forward is available (dry run)
#   1  refused on a real condition: DIVERGED, gitea ahead, push rejected
#   2  could not determine the answer — never treated as success
set -euo pipefail

APPLY=0
for arg in "$@"; do
	case "${arg}" in
	--apply) APPLY=1 ;;
	*)
		echo "usage: $0 [--apply]" >&2
		exit 2
		;;
	esac
done

die_unknown() {
	echo "‼ mirror-sync: CANNOT DETERMINE — $*" >&2
	echo "  Refusing to push, and refusing to report success, without an answer." >&2
	exit 2
}

refuse() {
	echo "✖ mirror-sync: REFUSED — $*" >&2
	exit 1
}

# --- Resolve both ends ---------------------------------------------------------
if [[ -z "${GITHUB_URL:-}" ]]; then
	GITHUB_URL="$(node -e "
    const r = require('./package.json').repository;
    const u = (typeof r === 'string' ? r : r && r.url) || '';
    process.stdout.write(u.replace(/^git\+/, '').replace(/\.git$/, ''));
  " 2>/dev/null || true)"
fi
[[ -n "${GITHUB_URL}" ]] || die_unknown "no GitHub upstream in package.json 'repository.url' and \${GITHUB_URL} unset"

# The gitea URL may carry a token, so it is never echoed; GITEA_LABEL is.
if [[ -n "${GITEA_URL:-}" ]]; then
	GITEA_LABEL="\$GITEA_URL"
elif [[ -n "${CI:-}" ]]; then
	[[ -n "${CI_REPO_CLONE_URL:-}" ]] || die_unknown "CI set but \$CI_REPO_CLONE_URL is empty"
	[[ -n "${REGISTRY_TOKEN:-}" ]] ||
		refuse "no \$REGISTRY_TOKEN — the gitea push credential is missing (Woodpecker secret gitea_token)"
	GITEA_URL="${CI_REPO_CLONE_URL/:\/\//://${REGISTRY_TOKEN}@}"
	GITEA_LABEL="\$CI_REPO_CLONE_URL"
else
	GITEA_REMOTE="${GITEA_REMOTE:-gitea}"
	GITEA_URL="$(git remote get-url "${GITEA_REMOTE}" 2>/dev/null)" ||
		die_unknown "no '${GITEA_REMOTE}' remote configured (set \${GITEA_URL} or \${GITEA_REMOTE})"
	GITEA_LABEL="remote '${GITEA_REMOTE}'"
fi

echo "▸ github upstream : ${GITHUB_URL}"
echo "▸ gitea           : ${GITEA_LABEL}"
MODE="dry run (pass --apply to push)"
[[ ${APPLY} -eq 1 ]] && MODE="apply"
echo "▸ mode            : ${MODE}"

# --- Fetch both tips ------------------------------------------------------------
git fetch --quiet "${GITHUB_URL}" main 2>/dev/null ||
	die_unknown "could not fetch main from ${GITHUB_URL} (network? repo renamed?)"
GH_TIP="$(git rev-parse FETCH_HEAD)"
git fetch --quiet "${GITEA_URL}" main 2>/dev/null ||
	die_unknown "could not fetch main from gitea (${GITEA_LABEL})"
GT_TIP="$(git rev-parse FETCH_HEAD)"
echo "▸ github tip      : ${GH_TIP}"
echo "▸ gitea tip       : ${GT_TIP}"

shallow="$(git rev-parse --is-shallow-repository 2>/dev/null)" ||
	die_unknown "could not tell whether this clone is shallow"
if [[ "${shallow}" = "true" ]]; then
	git fetch --quiet --unshallow 2>/dev/null ||
		die_unknown "shallow clone and could not unshallow — ancestry is not computable"
	git fetch --quiet "${GITHUB_URL}" main 2>/dev/null ||
		die_unknown "could not re-fetch main from ${GITHUB_URL} after unshallowing"
fi

if [[ "${GH_TIP}" = "${GT_TIP}" ]]; then
	echo "✔ mirror-sync: in sync — nothing to push."
	exit 0
fi

# --- Prove the shape ------------------------------------------------------------
# `merge-base --is-ancestor` exits 0 (yes), 1 (no) or something else (error).
# Only an explicit 0 or 1 counts as an answer; anything else is "unknown".
ancestry() {
	local rc=0
	git merge-base --is-ancestor "$1" "$2" 2>/dev/null || rc=$?
	case "${rc}" in
	0) ANSWER=yes ;;
	1) ANSWER=no ;;
	*) die_unknown "merge-base --is-ancestor $1 $2 failed (exit ${rc}) — history incomplete?" ;;
	esac
}

ancestry "${GT_TIP}" "${GH_TIP}"
gitea_behind="${ANSWER}"
ancestry "${GH_TIP}" "${GT_TIP}"
github_behind="${ANSWER}"

if [[ "${gitea_behind}" = "yes" ]]; then
	behind="$(git rev-list --count "${GT_TIP}..${GH_TIP}")" ||
		die_unknown "rev-list failed on a range whose ancestry was just proven"
	[[ "${behind}" =~ ^[1-9][0-9]*$ ]] || die_unknown "unexpected rev-list count '${behind}'"
	echo "▸ shape           : FAST-FORWARDABLE (gitea ${behind} commit(s) behind github)"
	git log --format='    %h %<(20,trunc)%an %s' --no-decorate -n 10 "${GT_TIP}..${GH_TIP}"
elif [[ "${github_behind}" = "yes" ]]; then
	refuse "gitea is AHEAD of github. Publishing gitea commits to the public repo is a human
  decision (docs/RELEASING.md); this job only ever moves gitea forward."
else
	refuse "DIVERGED — both tips have commits the other lacks. A push cannot fix a fork;
  merge one side into the other locally, push BOTH, and re-run the gates."
fi

if [[ ${APPLY} -eq 0 ]]; then
	echo "✔ mirror-sync: dry run — would fast-forward gitea main to ${GH_TIP}."
	exit 0
fi

# --- Push -----------------------------------------------------------------------
# Probe first: a credential that authenticates but cannot write is refused here,
# before anything moves. Then a plain (never forced) push: if gitea moved since
# the fetch, the server rejects the non-fast-forward and we stop.
git push --dry-run --quiet "${GITEA_URL}" "${GH_TIP}:refs/heads/main" >/dev/null 2>&1 ||
	refuse "push probe rejected — the gitea credential cannot push to main, or main moved"
git push --quiet "${GITEA_URL}" "${GH_TIP}:refs/heads/main" >/dev/null 2>&1 ||
	refuse "push rejected by gitea — nothing was moved by this job"

# Read back: a push that "succeeded" but left the tip elsewhere is not a success.
git fetch --quiet "${GITEA_URL}" main 2>/dev/null ||
	die_unknown "pushed, but could not read gitea main back to verify"
NEW_TIP="$(git rev-parse FETCH_HEAD)"
[[ "${NEW_TIP}" = "${GH_TIP}" ]] ||
	die_unknown "pushed, but gitea main reads ${NEW_TIP}, not ${GH_TIP}"
echo "✔ mirror-sync: fast-forwarded gitea main ${GT_TIP:0:12} → ${GH_TIP:0:12}."
