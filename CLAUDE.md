# CLAUDE.md

## Project Overview

`claudecode-linter` is a standalone TypeScript CLI that lints and auto-fixes Claude Code plugins and configuration files. It validates 8 artifact types with scope-aware rules, configurable severity, and human/JSON output.

## Build & Test

```bash
npm run build               # tsc → dist/
npm test                    # vitest run (165 tests)
npm run dev                 # tsc --watch
npm run extract-contracts   # pull contracts from latest Claude Code (Zod + schemastore)
npm run fetch-schemastore   # refresh contracts/schemastore/ only
npm run fetch-module-replacements  # refresh contracts/module-replacements/ snapshot
npm run generate-contracts  # regenerate src/contracts.ts from JSON
npm run knip                # find unused exports/dependencies
npm run check-deps          # check deps against the vendored module-replacements snapshot
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
  plugin-schema.ts  Lazy loader + Ajv compilation for plugin/lsp/monitors JSON Schemas
  config.ts         Load .claudecode-lint.yaml, merge with CLI flags
  discovery.ts      Find artifacts by convention, detect scope (user/project/subdirectory)
  linters/          One file per artifact type, each exports a Linter
  fixers/           Auto-fix implementations (plugin-json key sorting, frontmatter normalization)
  formatters/       Output formatting (human with picocolors, JSON)
  utils/            Shared helpers (YAML frontmatter parser, kebab-case validation)
contracts/
  claude-code-contracts.json  Extracted contracts from Claude Code (source of truth)
  plugin.schema.json          Auto-extracted JSON Schema for plugin.json (Zod → JSON Schema)
  lsp.schema.json             Auto-extracted JSON Schema for .lsp.json
  monitors.schema.json        Auto-extracted JSON Schema for monitors/monitors.json
  module-replacements/        Vendored es-tooling/module-replacements snapshot + provenance
scripts/
  extract-contracts.ts        AST-based extractor: contract sets (tools, events, fields…)
  extract-plugin-schema.ts    Zod → JSON Schema walker for plugin/lsp/monitors validators
  generate-contracts.ts       Codegen: reads JSON → writes src/contracts.ts
  fetch-module-replacements.ts  Vendors the module-replacements manifests (deliberate refresh)
  check-deps.ts               Offline dependency gate over the vendored snapshot
tests/
  linters/          Test files matching src/linters/ 1:1
  scripts/          Unit tests for the Zod walker (extract-plugin-schema.test.ts)
  fixtures/         valid-plugin/ (complete valid plugin) + invalid/ (per-artifact bad files)
```

## Schema extraction pipeline

`scripts/extract-plugin-schema.ts` walks Claude Code's minified Zod schemas and emits JSON Schema (draft-2020-12) for these validators:

1. **plugin.json** — master schema located via the "kebab-case" error string anchor near `.strict().safeParse(...)`; composed from N spread sub-schemas (`{...sub().shape, ...sub().partial().shape}`).
2. **`.lsp.json`** — `E.record(E.string(), RSH())` where RSH is located via the "extensionToLanguage must have at least one mapping" anchor.
3. **monitors/monitors.json** — `E.array(M09())` where the wrapping array is located via the "Monitor names must be unique" anchor.
4. **settings.json** — `y.object({...}).passthrough()` located via the "JSON Schema reference for Claude Code settings" describe anchor.
5. **skill/agent/command frontmatter** — per-artifact frontmatter objects located via field-specific describe anchors.
6. **`.mcp.json`** — `y.object({mcpServers:y.record(y.string(), <server-union>)})` located via the `mcpServers:y.record(y.string(),` source anchor. The server union is a `z.union` of transport configs (stdio / sse / http / streamable-http / …).
7. **hooks/hooks.json** — `{hooks:HC()}` where `HC` (the hook-event → matcher-array `partialRecord`) is located via the `y.partialRecord(` anchor. The per-hook discriminated union is declared as a block-body arrow factory the walker resolves by destructuring its helper function. The same `HC` shape also fills settings.json's embedded `hooks` key.

The walker auto-detects the Zod alias (`E`/`I`/`y`/…) and the lazy-wrapper helper (`CH(()=>…)`/`xH(()=>…)`/…) per release — minifier rotations don't break extraction. A drift gate (>30% top-level field loss vs the previous extraction) fails CI; override with `FORCE_SCHEMA=1`.

Verified against 2.1.131 (older symbol set) and 2.1.138 (current). When extraction does break on a new release, the walker falls back to `{}` (permissive) per missing primitive — never emits a stricter schema than Claude Code actually enforces.

### Schemastore.org as a secondary source (gitea#6)

The contract-sync pipeline also fetches the four schemastore.org-curated Claude Code schemas into `contracts/schemastore/`:

| Schemastore file | Used by |
|---|---|
| `settings.schema.json` | reference / future cross-check (Zod extraction is primary — schemastore lags, e.g. it still types `disableAutoMode` as a string literal long after the runtime switched to boolean) |
| `plugin-manifest.schema.json` | reference (Zod extraction is primary) |
| `marketplace.schema.json` | sole source for the `marketplace-json` linter — no Zod source in the bundle |
| `keybindings.schema.json` | sole source for the `keybindings-json` linter — no Zod source in the bundle |

The schemastore fetch happens in `npm run extract-contracts` and on each CI release. The committed JSONs ship in the published package via the `files` array.

## Dependency gate — vendored, offline, fail-closed (gitea#25)

`npm run check-deps` compares this package's dependencies against the
`es-tooling/module-replacements` manifests **committed under
`contracts/module-replacements/`**, not fetched at gate time.

It used to fetch `raw.githubusercontent.com` on every CI run, which broke two
ways at once:

- An upstream addition reddened `main` and every open PR with no change here.
  It happened: upstream added `semver` to `preferred.json` and unrelated
  dependabot runs went red.
- A non-OK response was logged and `continue`d, so a network blip made the gate
  **pass having compared nothing** — fail-open on unreachability while
  fail-closed on content.

Vendoring fixes the first. The second is fixed independently and is the more
important half: every way of failing to load a manifest — missing file,
unreadable, malformed JSON, no `mappings`, **empty `mappings`** — is fatal, and
`fetch-module-replacements.ts` throws on any non-OK response or network error
rather than writing a partial snapshot. `tests/scripts/check-deps.test.ts`
asserts each of those paths exits non-zero.

Refresh deliberately with `npm run fetch-module-replacements` (`--ref <sha>` to
pin an upstream commit). The `refresh-module-replacements` workflow does this
weekly and opens a PR, so an upstream edit arrives as a diff someone reviews.

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
| `lsp-json` | `.lsp.json` | — |
| `monitors-json` | `monitors/monitors.json` | — |
| `marketplace-json` | `.claude-plugin/marketplace.json` | — |
| `keybindings-json` | `keybindings.json`, `.claude/keybindings.json` | user, project |

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

**These pipelines are not a chain.** Both npmjs-publishing workflows check out
`origin` (github.com/retif); most PRs merge on `gitea`, and nothing pushes
`gitea/main` → `origin/main`. A fix merged on Gitea is invisible to them, silently
and indefinitely. The Woodpecker pipeline builds from Gitea but publishes to the
Gitea npm registry, which consumers do not install from. Before claiming a fix is
live, run `git rev-list --left-right --count origin/main...gitea/main` (want `0 0`)
and check `npm view claudecode-linter version`. Full procedure — including the
`patch-release.yml` escape hatch for fix-only changes and the emmett nix pin bump —
in [`docs/RELEASING.md`](docs/RELEASING.md).

## Conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions
- Strict TypeScript, target ES2022, module Node16
- Tests use vitest with fixture files (not inline snapshots)
- Exit code: 0 = clean, 1 = errors found
- Linter constants live in `src/contracts.ts` (auto-generated, do not edit manually)
