#!/usr/bin/env bash
# Woodpecker step: release (release.yml) — bump, commit, tag, push, publish, release.
# Single step because Woodpecker only injects secrets into one step.
#
# Requires env: REGISTRY_TOKEN, CI_REPO_CLONE_URL, CI_REPO_OWNER, CI_REPO_NAME,
# CI_COMMIT_BRANCH (all but REGISTRY_TOKEN are Woodpecker-injected).
# shellcheck disable=SC2154
set -e

VERSION=$(cat .claude-code-version)
GITEA_HOST=$(echo "$CI_REPO_CLONE_URL" | sed 's|https://||;s|/.*||')
GITEA_API="https://$GITEA_HOST/api/v1"
REPO_PATH="$CI_REPO_OWNER/$CI_REPO_NAME"
NPM_REGISTRY="https://$GITEA_HOST/api/packages/$CI_REPO_OWNER/npm"

echo "==> Preparing release v$VERSION"

# Bump package.json version
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.version = process.argv[1];
  fs.writeFileSync('package.json', JSON.stringify(p, null, '\t') + '\n');
" "$VERSION"
npm install --package-lock-only

# Prepend changelog entry
if [ -f CHANGELOG.md ]; then
  tail -n +2 CHANGELOG.md > CHANGELOG_OLD.md
  echo "# Changelog" > CHANGELOG.md
  echo "" >> CHANGELOG.md
  cat CHANGELOG_ENTRY.md >> CHANGELOG.md
  cat CHANGELOG_OLD.md >> CHANGELOG.md
  rm CHANGELOG_OLD.md
else
  echo "# Changelog" > CHANGELOG.md
  echo "" >> CHANGELOG.md
  cat CHANGELOG_ENTRY.md >> CHANGELOG.md
fi

echo "--- CHANGELOG preview ---"
head -40 CHANGELOG.md

# Commit and tag
git config user.name "Woodpecker CI"
git config user.email "ci@woodpecker"
git add -A
git commit -m "release: sync with Claude Code v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

# Push
PUSH_URL=$(echo "$CI_REPO_CLONE_URL" | sed "s|://|://$REGISTRY_TOKEN@|")
echo "==> Pushing v$VERSION..."
git push "$PUSH_URL" HEAD:$CI_COMMIT_BRANCH --tags

# Pack + publish to the Gitea npm registry via the SHARED scriptset
# (oleks/emmett#44). The same ci/stage.sh + ci/publish.sh run locally on
# emmett, so CI and local publishing cannot drift. VERSION (already the
# stripped Claude Code version here) overrides the derived tag; the dev-tag
# guard is satisfied because VERSION is set. ci/publish.sh resolves
# $REGISTRY_TOKEN and never prints it (no set -x in those scripts).
echo "==> Publishing to $NPM_REGISTRY via ci/ scriptset..."
VERSION="$VERSION" bash ci/stage.sh
VERSION="$VERSION" bash ci/publish.sh
TARBALL=$(cat .stage/.last-tarball)        # absolute path to the staged .tgz
TARBALL_NAME=$(basename "$TARBALL")
echo "Published $TARBALL_NAME to $NPM_REGISTRY"

# Build release body with install instructions
RELEASE_BODY=$(node -e "
  const changelog = require('fs').readFileSync('CHANGELOG_ENTRY.md', 'utf8');
  const install = [
    '### Install',
    '',
    '\`\`\`bash',
    '# Install from Gitea registry',
    'npm install claudecode-linter@$VERSION --registry $NPM_REGISTRY',
    '',
    '# Or configure registry permanently (one-time)',
    'npm config set //$GITEA_HOST/api/packages/$CI_REPO_OWNER/npm/:_authToken YOUR_TOKEN',
    'npm install claudecode-linter@$VERSION --registry $NPM_REGISTRY',
    '\`\`\`',
    '',
  ].join('\n');
  console.log(JSON.stringify(install + changelog));
")

echo "==> Creating Gitea release v$VERSION..."
curl -sf -X POST \
  -H "Authorization: token $REGISTRY_TOKEN" \
  -H "Content-Type: application/json" \
  "$GITEA_API/repos/$REPO_PATH/releases" \
  -d "{\"tag_name\":\"v$VERSION\",\"name\":\"v$VERSION\",\"body\":$RELEASE_BODY}"

RELEASE_ID=$(curl -sf \
  -H "Authorization: token $REGISTRY_TOKEN" \
  "$GITEA_API/repos/$REPO_PATH/releases/tags/v$VERSION" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

echo "==> Attaching $TARBALL_NAME (release $RELEASE_ID)..."
curl -sf -X POST \
  -H "Authorization: token $REGISTRY_TOKEN" \
  -F "attachment=@$TARBALL;type=application/gzip" \
  "$GITEA_API/repos/$REPO_PATH/releases/$RELEASE_ID/assets?name=$TARBALL_NAME"

# Cleanup CI-only files
rm -f CHANGELOG_ENTRY.md .claude-code-version *.tgz "$HOME/.npmrc"
rm -rf .stage
echo "==> Released v$VERSION"
