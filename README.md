# claude-lint

Standalone linter for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin artifacts.

Validates `plugin.json`, `SKILL.md`, agent/command markdown, `hooks.json`, `mcp.json`, `settings.json`, and `CLAUDE.md` files with 88 rules across 8 artifact types.

## Install

```bash
npm install -g claude-lint
```

Or run directly:

```bash
npx claude-lint ~/projects/my-plugin/
```

## Usage

### Lint

Check plugin artifacts for errors without modifying files. This is the default mode — `--lint` is optional:

```bash
# Lint a plugin directory
claude-lint --lint path/to/plugin/
claude-lint path/to/plugin/  # same thing

# Lint multiple paths
claude-lint plugin-a/ plugin-b/

# JSON output
claude-lint --output json path/to/plugin/

# Errors only
claude-lint --quiet path/to/plugin/

# Filter by rule
claude-lint --rule plugin-json/name-kebab-case path/to/plugin/

# Enable/disable specific rules
claude-lint --enable skill-md/word-count --disable claude-md/no-todos path/to/plugin/

# List all available rules
claude-lint --list-rules
```

### Format

Reformat all artifacts for consistent style (sorted keys, normalized indentation, trailing whitespace, kebab-case names, quoted YAML values). No lint output — just formats and reports what changed:

```bash
# Format all artifacts in place
claude-lint --format path/to/plugin/
```

### Fix

Fix lint violations in place, then lint the result — output shows only issues that remain after fixing:

```bash
# Fix issues in place
claude-lint --fix path/to/plugin/

# Preview fixes without writing (shows diff)
claude-lint --fix-dry-run path/to/plugin/
```

### Example Output

```
$ claude-lint my-plugin/

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
$ claude-lint --fix-dry-run my-plugin/

--- my-plugin/skills/deploy/SKILL.md
+++ my-plugin/skills/deploy/SKILL.md (fixed)
-name: My Deploy Skill
+name: my-deploy-skill
-description: Use when the user asks to "deploy": handles both cases.
+description: "Use when the user asks to \"deploy\": handles both cases."
```

```
$ claude-lint my-plugin/
No issues found.
```

## Artifact Types

| Type | Files | Rules |
|------|-------|-------|
| plugin-json | `.claude-plugin/plugin.json` | 12 |
| skill-md | `skills/*/SKILL.md` | 11 |
| agent-md | `agents/*.md` | 12 |
| command-md | `commands/*.md` | 4 |
| hooks-json | `hooks/hooks.json` | 9 |
| settings-json | `.claude-plugin/settings.json` | 8 |
| mcp-json | `.claude-plugin/mcp.json` | 10 |
| claude-md | `CLAUDE.md` | 22 |

## Configuration

Generate a config file with all rules and their default severities:

```bash
# Create .claude-lint.yaml in current directory
claude-lint --init

# Create in a specific directory
claude-lint --init ~/projects/my-plugin/

# Create in home directory (applies globally)
claude-lint --init ~
```

claude-lint looks for config in this order:

1. `.claude-lint.yaml` or `.claude-lint.yml` in the current directory
2. `.claude-lint.yaml` or `.claude-lint.yml` in `$HOME`
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

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
