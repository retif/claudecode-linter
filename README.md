# claude-lint

Standalone linter and formatter for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin artifacts.

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

```bash
# Lint a plugin directory
claude-lint path/to/plugin/

# Lint multiple paths
claude-lint plugin-a/ plugin-b/

# Auto-fix fixable issues
claude-lint -f path/to/plugin/

# Preview fixes without writing
claude-lint --fix-dry-run path/to/plugin/

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

The `--format` flag applies auto-fixes:

- **plugin-json**: Sorts keys, normalizes indent
- **skill-md / agent-md / command-md**: Normalizes frontmatter name to kebab-case, fixes trailing whitespace, quotes invalid YAML values (pre-parse fixer)
- **hooks-json**: Sorts keys, normalizes indent
- **mcp-json**: Sorts servers alphabetically, orders fields canonically
- **settings-json**: Sorts keys in canonical order, sorts permission arrays
- **claude-md**: Strips trailing whitespace, ensures trailing newline, blank lines before headings

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
