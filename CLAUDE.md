# CLAUDE.md

## Project Overview

`claudecode-linter` is a standalone TypeScript CLI that lints and auto-fixes Claude Code plugins and configuration files. It validates 8 artifact types with scope-aware rules, configurable severity, and human/JSON output.

## Build & Test

```bash
npm run build               # tsc → dist/
npm test                    # vitest run (165 tests)
npm run dev                 # tsc --watch
npm run extract-contracts   # pull contracts from latest Claude Code
npm run generate-contracts  # regenerate src/contracts.ts from JSON
npm run knip                # find unused exports/dependencies
npm run check-deps          # check for replaceable dependencies
```

## Usage

```bash
claudecode-linter [paths...]              # lint current dir or specified paths
claudecode-linter --scope user ~/.claude  # filter by scope
claudecode-linter -f .                    # auto-fix fixable issues
claudecode-linter --output json .         # JSON output
claudecode-linter --quiet .               # errors only
```

## Architecture

```
src/
  index.ts          CLI entry (commander)
  types.ts          Core types: LintDiagnostic, Severity, ArtifactType, Linter, Fixer, ConfigScope
  contracts.ts      Auto-generated contract constants (tools, events, fields, colors, models)
  config.ts         Load .claudecode-lint.yaml, merge with CLI flags
  discovery.ts      Find artifacts by convention, detect scope (user/project/subdirectory)
  linters/          One file per artifact type, each exports a Linter
  fixers/           Auto-fix implementations (plugin-json key sorting, frontmatter normalization)
  formatters/       Output formatting (human with picocolors, JSON)
  utils/            Shared helpers (YAML frontmatter parser, kebab-case validation)
contracts/
  claude-code-contracts.json  Extracted contracts from Claude Code (source of truth)
scripts/
  extract-contracts.ts        AST-based extractor: downloads Claude Code, parses cli.js
  generate-contracts.ts       Codegen: reads JSON → writes src/contracts.ts
tests/
  linters/          Test files matching src/linters/ 1:1
  fixtures/         valid-plugin/ (complete valid plugin) + invalid/ (per-artifact bad files)
```

## Linter Pattern

Every linter implements the `Linter` interface from `types.ts`:

```typescript
interface Linter {
  artifactType: ArtifactType;
  lint(filePath: string, content: string, config: LinterConfig, scope?: ConfigScope): LintDiagnostic[];
}
```

Rules are named `<artifact>/<rule>` (e.g., `plugin-json/name-kebab-case`). Use `isRuleEnabled()` and `getRuleSeverity()` from `types.ts` to respect config.

## Artifact Types & Scopes

| Artifact | Files | Scopes |
|----------|-------|--------|
| `plugin-json` | `.claude-plugin/plugin.json` | — |
| `skill-md` | `skills/*/SKILL.md` | — |
| `agent-md` | `agents/*.md`, `.claude/agents/*.md` | — |
| `command-md` | `commands/*.md` | — |
| `hooks-json` | `hooks/hooks.json` | — |
| `settings-json` | `settings.json`, `settings.local.json` | user, project |
| `mcp-json` | `.mcp.json`, `mcp.json` | user, project |
| `claude-md` | `CLAUDE.md` | user, project |

Scope detection (`discovery.ts`): files in `~/.claude/` or `~/` → user, files in project `.claude/` → project.

## Configuration

`.claudecode-lint.yaml` at project root:

```yaml
rules:
  plugin-json/name-kebab-case: false          # disable rule
  claude-md/file-length: { severity: error }  # override severity
```

## Versioning

Version tracks Claude Code: `2.1.69` = synced with Claude Code v2.1.69.
Linter-only bugfixes use pre-release: `2.1.69-patch.1`, `2.1.69-patch.2`, etc.
Next Claude Code release (e.g., `2.1.70`) supersedes all patches.

CI pipelines automate releases:

- **Full release** (`.github/workflows/release.yml`): Cron every 6h + manual. Checks npm for new Claude Code version → extract → generate → build → test → bump → changelog → tag → publish to npmjs → GitHub Release.
- **Patch release** (`.github/workflows/patch-release.yml`): Manual `workflow_dispatch` with reason. Auto-increments `-patch.N` suffix from existing tags → build → test → bump → tag → publish to npmjs → GitHub Release.
- **Gitea release** (`.woodpecker/release.yml`): Manual trigger. Same full-release flow but publishes to Gitea npm registry and creates Gitea release.

## Conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions
- Strict TypeScript, target ES2022, module Node16
- Tests use vitest with fixture files (not inline snapshots)
- Exit code: 0 = clean, 1 = errors found
- Linter constants live in `src/contracts.ts` (auto-generated, do not edit manually)
