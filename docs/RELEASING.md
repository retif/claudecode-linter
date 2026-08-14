# Releasing

How a change in this repo becomes the `claudecode-linter` that actually runs on a
developer machine. Read this before assuming a merged fix is live.

## The one thing that surprises people

**Merging a fix to `gitea/main` ships it to nobody.**

This repo has two remotes and three release pipelines, and they do not form a
single chain:

| Remote | URL | Visibility |
|---|---|---|
| `origin` | `github.com/retif/claudecode-linter` | public — **this is what npmjs releases are cut from** |
| `gitea` | `git.oleks.space/oleks/claudecode-linter` | private — where issues, PRs and most agent work land |

| Pipeline | Runs on | Checks out | Publishes to |
|---|---|---|---|
| `.github/workflows/release.yml` | GitHub Actions (cron 6h + manual) | `origin` | **npmjs.org** |
| `.github/workflows/patch-release.yml` | GitHub Actions (manual only) | `origin` | **npmjs.org** |
| `.woodpecker/release.yml` | Woodpecker (manual) | `gitea` | Gitea npm registry |

Both pipelines that publish to **npmjs.org check out `origin`**. Nothing pushes
`gitea/main` → `origin/main`. So a PR merged on Gitea is invisible to them, and
stays invisible indefinitely — no error, no warning, no stale marker.

The Woodpecker pipeline *does* build from Gitea, but it publishes to the **Gitea
npm registry**, which is not where consumers install from (see "Reaching the
fleet" below). It is therefore not an escape hatch for this problem.

Recorded occurrence: PRs #15, #16 and #17 (fixes for issues #12, #13, #14) were
merged to `gitea/main` on 2026-08-14 and left `gitea/main` 14 commits ahead of
`origin/main`. `npm view claudecode-linter version` still returned `2.1.231` —
byte-identical to the version already installed fleet-wide — so all three fixes
were inert on every machine while reading as "merged, done". Tracked as #18.

**Check before you believe a fix is live:**

```bash
git fetch --all
git rev-list --left-right --count origin/main...gitea/main   # want: 0  0
npm view claudecode-linter version                            # what consumers get
```

A non-zero right-hand number means there are merged commits no release can see.

**This is now checked automatically.** `ci/check-mirror-drift.sh` compares both tips
in both directions and fails once the oldest unmirrored commit is older than
`MAX_DRIFT_HOURS` (default 24) — drift right after a merge is expected and clears
when you cut the release; drift that has *sat* is the bug. It runs from the Gitea
side via `.woodpecker/mirror-drift.yml` (cron + manual), because the GitHub upstream
is public and readable without credentials while the private Gitea repo is not.

Run it locally any time:

```bash
bash ci/check-mirror-drift.sh              # exit 0 in sync, 1 drifted, 2 couldn't tell
MAX_DRIFT_HOURS=0 bash ci/check-mirror-drift.sh   # strict: fail on any drift
```

Exit code 2 is deliberate: if the check cannot compute an answer (unreachable
upstream, shallow clone with no common history) it reports "cannot determine" rather
than success. A check that fails open is the same silent-failure class it exists to
catch.

## Route A — contract sync (automatic)

When Anthropic publishes a new Claude Code version, `release.yml` picks it up on
its 6-hourly cron: extract contracts → generate → build → test → bump version to
match Claude Code exactly → changelog → tag → publish to npmjs → GitHub Release.

Nothing to do. This route works on its own **as long as `origin/main` is
current** — which is exactly the assumption that failed above.

## Route B — linter-only fix (manual, and the one that gets missed)

`release.yml` **cannot** ship a fix on its own. Its version check is:

```bash
LATEST=$(npm view @anthropic-ai/claude-code version)
if [ "$(npm view "claudecode-linter@$LATEST" version)" = "$LATEST" ]; then skip
```

It keys entirely on the *Claude Code* version. If `claudecode-linter@2.1.231` is
already on npm, it skips — no matter how many linter fixes have landed since.
That is by design (the version tracks Claude Code), but it means a fix-only
change has **no automatic path to release at all**. It would otherwise sit until
Anthropic happens to ship a new version, then get published incidentally.

The deliberate escape hatch is `patch-release.yml`, which cuts a `-patch.N`
pre-release (`2.1.231-patch.1`, `2.1.231-patch.2`, …). Pre-releases sort below
the base version but still satisfy `^2.1.x`.

Full sequence for a linter-only fix:

```bash
# 1. Reconcile the remotes — the step with no automation behind it.
git fetch --all
git rev-list --left-right --count origin/main...gitea/main    # confirm the gap
git push origin gitea/main:main                                # publish to upstream

# 2. Cut the patch release (publishes to npmjs + creates a GitHub Release).
gh workflow run patch-release.yml -f reason="fix #NN: <what it fixes>"
gh run watch "$(gh run list --workflow=patch-release.yml -L1 --json databaseId -q '.[0].databaseId')"

# 3. Confirm it is actually on npm before touching the fleet.
npm view claudecode-linter version
```

Step 1 pushes commits from a **private** repo to a **public** one. That is a
deliberate, non-reversible disclosure decision — do not automate it silently, and
do not let an agent make the call unilaterally.

## Reaching the fleet (emmett)

Publishing to npm is still not "live". Emmett's pre-push `CCL` lint slot installs
a **pinned** tarball, so it does not follow npm's `latest`:

`~/projects/servers/emmett/nixos/claudecode-linter.nix`

```nix
version = "2.1.231";
src = pkgs.fetchurl {
  url = "https://registry.npmjs.org/claudecode-linter/-/claudecode-linter-${version}.tgz";
  hash = "sha256-EHRDvQZ8ikzqK/gY4i6/31gLDMcKb2MEhAhmMb4PuQY=";
};
npmDepsHash = "sha256-x3AZsDTZi4KvhcJtpAvktgr1TtsIvfHJPzapqRIBQIU=";
```

That module fetches the **npmjs** tarball deliberately: this Gitea repo is
private and emmett dispatches every build to a credential-less remote builder
(`max-jobs = 0`), so a `fetchgit` against the private remote cannot work, and the
Gitea npm registry needs a token the builder does not have. npmjs is the only
source any builder can reach unauthenticated.

Per release, three things must change together:

1. `version` — the newly published version.
2. `hash` — `nix store prefetch-file --json <tarball-url> | jq -r .hash`.
3. `claudecode-linter-package-lock.json` + `npmDepsHash` — the published tarball
   ships no lockfile (`npm pack` excludes it), so it is vendored beside the
   module. Regenerate it against the **new** tarball's `package.json` with
   `npm install --package-lock-only --ignore-scripts`, then update `npmDepsHash`.

Then deploy emmett. Because this is a NixOS system change, it is
**source-committed only until activated**: label the issue `nixos-deploy-pending`
on push, note it on emmett's rolling deploy tracker
[oleks/emmett#120](https://git.oleks.space/oleks/emmett/issues/120), and flip to
`nixos-deployed` once deploy-rs activation is verified live on the host.

## Verifying a fix is genuinely live

A version number is not proof — `--version` reported `2.1.231` both before and
after the three stranded fixes, because the version never changed. Test the
**behaviour** instead, with a fixture that the fix specifically changes:

```bash
# Example for #12 (HTML comments in a SKILL.md description):
claudecode-linter path/to/fixture     # before: 1 error   after: No issues found.
```

Two runs of the same fixture against the installed binary and a fresh build of
`gitea/main` give opposite answers when a fix has not landed. That is the check
that actually caught #18.

## Checklist

- [ ] `git rev-list --left-right --count origin/main...gitea/main` → `0  0`
- [ ] Published version visible in `npm view claudecode-linter version`
- [ ] `version`, `hash`, vendored lockfile and `npmDepsHash` all bumped together
- [ ] Emmett deployed and activation verified live on the host
- [ ] Behaviour verified with a fixture, not a `--version` string
- [ ] Issue flipped `nixos-deploy-pending` → `nixos-deployed`; rolling tracker updated
