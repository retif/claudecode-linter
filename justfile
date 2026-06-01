# justfile — uniform local-parity front door for claudecode-linter.
# See oleks/emmett#44 (Local Pipeline Parity), archetype: npm-library.
# Dispatches to ci/local.sh (the shared scriptset CI also calls).

# default: dry-run (build + npm pack into the local store, no publish)
default: stage

# BUILD-parity: build, test, npm pack into .stage/ — no registry contact
stage:
    bash ci/stage.sh

# dry-run convenience: stage + print the publish plan (no push)
publish-dry:
    bash ci/local.sh --dry-run

# PUBLISH-parity: stage + push to the Gitea npm registry (explicit opt-in)
publish:
    bash ci/local.sh --publish
