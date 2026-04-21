# claudecode-linter

[![CI](https://github.com/retif/claudecode-linter/actions/workflows/ci.yml/badge.svg)](https://github.com/retif/claudecode-linter/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/claudecode-linter)](https://www.npmjs.com/package/claudecode-linter)
[![license](https://img.shields.io/npm/l/claudecode-linter)](https://github.com/retif/claudecode-linter/blob/main/LICENSE)
[![Socket Badge](https://socket.dev/api/badge/npm/package/claudecode-linter)](https://socket.dev/npm/package/claudecode-linter)

Standalone linter for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugins and configuration files.

Validates `plugin.json`, `SKILL.md`, agent/command markdown, `hooks.json`, `mcp.json`, `settings.json`, and `CLAUDE.md` files with 90 rules across 8 artifact types.

![demo](assets/demo.gif)

## Install

```bash
npm install -g claudecode-linter
```

Or run directly:

```bash
npx claudecode-linter ~/projects/my-plugin/
```

## Usage

### Lint

Check plugin artifacts for errors without modifying files. This is the default mode — `--lint` is optional:

```bash
# Lint a plugin directory
claudecode-linter --lint path/to/plugin/
claudecode-linter path/to/plugin/  # same thing

# Lint multiple paths
claudecode-linter plugin-a/ plugin-b/

# JSON output
claudecode-linter --output json path/to/plugin/

# Errors only
claudecode-linter --quiet path/to/plugin/

# Filter by rule
claudecode-linter --rule plugin-json/name-kebab-case path/to/plugin/

# Enable/disable specific rules
claudecode-linter --enable skill-md/word-count --disable claude-md/no-todos path/to/plugin/

# List all available rules
claudecode-linter --list-rules
```

### Format

Reformat all artifacts for consistent style (sorted keys, normalized indentation, trailing whitespace, kebab-case names, quoted YAML values). No lint output — just formats and reports what changed:

```bash
# Format all artifacts in place
claudecode-linter --format path/to/plugin/
```

### Fix

Fix lint violations in place, then lint the result — output shows only issues that remain after fixing:

```bash
# Fix issues in place
claudecode-linter --fix path/to/plugin/

# Preview fixes without writing (shows diff)
claudecode-linter --fix-dry-run path/to/plugin/
```

### Example Output

```
$ claudecode-linter my-plugin/

my-plugin/skills/example/SKILL.md
  warn   Body has 117 words (recommended: 500-5000)  skill-md/body-word-count:5

my-plugin/.claude/settings.json
  error  "settings.json" should only exist at user level (~/.claude/).
         Use "settings.local.json" for project-level settings  settings-json/scope-file-name
  warn   "env" is a user-level field — it has no effect in
         project-level settings.local.json  settings-json/scope-field:9:3

1 error, 2 warnings
```

```
$ claudecode-linter --fix-dry-run my-plugin/

--- my-plugin/skills/deploy/SKILL.md
+++ my-plugin/skills/deploy/SKILL.md (fixed)
-name: My Deploy Skill
+name: my-deploy-skill
-description: Use when the user asks to "deploy": handles both cases.
+description: "Use when the user asks to \"deploy\": handles both cases."
```

```
$ claudecode-linter my-plugin/
No issues found.
```

## Artifact Types

| Type | Files | Rules |
|------|-------|-------|
| plugin-json | `.claude-plugin/plugin.json` | 12 |
| skill-md | `skills/*/SKILL.md` | 11 |
| agent-md | `agents/*.md` | 13 |
| command-md | `commands/*.md` | 5 |
| hooks-json | `hooks/hooks.json` | 9 |
| settings-json | `.claude-plugin/settings.json` | 14 |
| mcp-json | `.claude-plugin/mcp.json` | 16 |
| claude-md | `CLAUDE.md` | 10 |

## Configuration

Generate a config file with all rules and their default severities:

```bash
# Create .claudecode-lint.yaml in current directory
claudecode-linter --init

# Create in a specific directory
claudecode-linter --init ~/projects/my-plugin/

# Create in home directory (applies globally)
claudecode-linter --init ~
```

claudecode-linter looks for config in this order:

1. `.claudecode-lint.yaml` or `.claudecode-lint.yml` in the current directory
2. `.claudecode-lint.yaml` or `.claudecode-lint.yml` in `$HOME`
3. Bundled defaults (all rules enabled at their default severity)

Example config:

```yaml
rules:
  plugin-json/name-kebab-case: true
  skill-md/word-count:
    severity: warning
    min: 50
  claude-md/no-todos: false
```

## Fixers

Both `--format` and `--fix` run the same fixers. The difference: `--format` only formats and reports changes, `--fix` also lints the result afterwards.

Formatting is powered by [prettier](https://prettier.io/) for consistent JSON and markdown output. Custom logic handles domain-specific transformations that prettier can't (key sorting, YAML fixes, kebab-case normalization).

| Artifact | Prettier | Custom logic |
|----------|----------|--------------|
| plugin-json | Tab-indented JSON | Canonical key ordering |
| hooks-json | 2-space JSON | Alphabetical key sorting |
| mcp-json | 2-space JSON | Server name sorting, canonical field ordering |
| settings-json | 2-space JSON | Canonical key ordering, permission array sorting |
| skill-md / agent-md / command-md | Markdown body | Frontmatter YAML normalization, kebab-case names, pre-parse quoting |
| claude-md | Markdown | Blank line before headings |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | No errors |
| 1 | Lint errors found |
| 2 | Fatal error |

## Versioning

This linter's version tracks the Claude Code version it was extracted from:

- **Contract sync**: version matches Claude Code exactly (e.g., `2.1.69` for Claude Code v2.1.69)
- **Linter-only bugfix**: pre-release suffix `2.1.69-patch.1`, `2.1.69-patch.2`, etc.

Pre-release versions sort below the base version in npm (`2.1.69-patch.1 < 2.1.69`), but `^2.1.68` will still resolve them. When the next Claude Code version is released (e.g., `2.1.70`), it supersedes all patches.

## Development

```bash
npm install
npm run build
npm test
```

### Updating contracts

When a new Claude Code version is released:

```bash
# 1. Extract contracts from latest Claude Code
npm run extract-contracts

# Or extract from a specific version
npm run extract-contracts -- --version 2.1.58

# 2. Generate src/contracts.ts from the JSON
npm run generate-contracts

# 3. Build and test
npm run build && npm test
```

The `--version` flag is useful for testing the CI pipeline: extract an older version, commit it, then let CI detect the newer latest version and run the full release flow.

Use `--changelog` to also write a `CHANGELOG_ENTRY.md` file with a markdown drift report (used by CI):

```bash
npm run extract-contracts -- --changelog
```

This is automated in CI via `.github/workflows/release.yml`.

## License

MIT
