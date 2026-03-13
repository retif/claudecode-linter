# Robust Contract Extraction

Replace fragile anchor-based Zod parsing with a hybrid string census + d.ts parsing approach that survives bundle restructuring.

## Problem

The extractor (`scripts/extract-contracts.ts`) uses hardcoded AST patterns and `.describe()` string anchors to find contract values in Claude Code's minified `cli.js`. When Claude Code updates their bundle structure, these patterns silently break — returning empty arrays. The `mergeWithPrevious` safety net prevents data loss but accumulates stale values and hides degradation.

Affected: `pluginJsonFields`, `agentFrontmatter`, `agentModels`, `commandFrontmatter`, `mcpServerFields`, `hookTypes`, `promptEvents`, `settingsFields`, `skillFrontmatter`.

## Design

### Layer 1: String Census (primary extraction)

Extend the existing `collectStringSets()` approach to also collect object-key sets from the AST.

**Current**: collects string arrays/Sets, classifies by anchor overlap for tools, hook events, and colors.

**New**: also walk the AST for `ObjectExpression` nodes and collect top-level property key names as sets. This captures Zod `I.object({ name: ..., version: ... })` patterns by their keys, regardless of code structure.

**Collection constraints**:
- Minimum object size: skip objects with fewer than 3 keys (noise filter)
- Maximum object size: skip objects with more than 150 keys (unlikely to be schema definitions)
- Deduplicate identical key sets

**Classification scoring formula**:

```
score = intersectionCount / max(candidateSize, knownSize)
```

This is a Jaccard-like ratio that penalizes both too-large candidates (large object with incidental overlap) and too-small candidates (subset match).

**Threshold rules**:
- Minimum overlap floor: at least 3 known values must match (absolute count)
- Minimum score: 0.3 (at least 30% Jaccard-like overlap)
- If multiple sets pass both thresholds, pick the highest score; break ties by size proximity to previous known set
- New keys in the winning set are included as new contract values

**Single-value categories** (e.g., `settingsProjectFields` with only `["permissions"]`): the census approach cannot meaningfully classify these — the overlap floor of 3 is impossible to meet. These categories keep their current anchor-based extraction as a fallback. If the anchor also fails, `mergeWithPrevious` preserves the previous value.

**Tool extraction**: the existing `classifySets()` approach for tools (PascalCase filter + anchor overlap) and `extractAllToolNames()` (regex literal search) remain unchanged. These are not fragile — PascalCase is a strong discriminator, and tool name literals are stable in the bundle. The object-key census does not replace tool extraction.

**What this survives**:
- `.describe()` text changes
- Bundler restructuring
- Schema library changes (Zod to anything else)
- Code reordering

**Risk**: two unrelated schemas sharing many key names. Mitigated by the scoring formula (penalizes size mismatch), the absolute overlap floor, and the fact that contract categories have distinct field vocabularies.

### Layer 2: d.ts Parsing (cross-validation for tools)

The file `sdk-tools.d.ts` exists in the current npm tarball at `package/sdk-tools.d.ts` (verified in v2.1.74). `fetchCliSource()` is extended to also read this file if present.

Parse with regex:

```
/export interface (\w+)Input\b/  →  tool names
```

Apply static name mapping for known mismatches:

| d.ts name | Contract name |
|-----------|---------------|
| FileRead | Read |
| FileEdit | Edit |
| FileWrite | Write |

Usage:
- Tools in census but not d.ts: expected (internal tools like `LSP`, `Skill`, `SendMessage`)
- Tools in d.ts but not census: warning — possibly new tool the census missed, add to contracts
- d.ts file absent from tarball: log warning, skip this layer entirely (census-only)
- d.ts parsing returns empty: log warning, skip (do not fail the build)

### Layer 3: CI Contract Gate

After extraction but **before** `mergeWithPrevious`, compare raw extracted values vs previous contracts for each of the 13 categories:

| Drop | Action |
|------|--------|
| >30% | Fail build, list lost values |
| 1-30% | Warn, proceed |
| 0% or growth | Pass silently |

The gate operates on **pre-merge** values so it detects actual extraction degradation. `mergeWithPrevious` is applied after the gate passes (or after override).

Override mechanisms:
- **GitHub Actions**: `FORCE_CONTRACTS=1` env var, settable via `workflow_dispatch` inputs
- **Woodpecker**: `FORCE_CONTRACTS` pipeline variable, settable per-run in the Woodpecker UI

`mergeWithPrevious` stays as a soft merge (union values) applied after the gate.

## Changes to Existing Code

### `scripts/extract-contracts.ts`

**Keep**:
- `fetchCliSource()` — download and unpack (extended to also read `sdk-tools.d.ts`)
- `collectStringSets()` — string array/Set collection
- `classifySets()` — tool/event/color classification (including PascalCase tool detection)
- `extractAllToolNames()` — regex literal tool search (not fragile)
- `mergeWithPrevious()` — soft merge safety net
- `computeDrift()` — drift reporting
- Changelog generation
- Anchor-based extraction for single-value categories (`settingsProjectFields`) as fallback

**Replace**:
- `extractZodObjectKeys()` and `extractTopLevelKeys()` — replaced by object-key census
- Individual `extract*` functions that use backward anchor search:
  - `extractPluginJsonFields` → census classification
  - `extractAgentFrontmatterFields` → census classification
  - `extractAgentModelEnum` → census classification (small enum set)
  - `extractCommandFrontmatterFields` → census classification
  - `extractMcpServerFields` → census classification
  - `extractHookTypes` → census classification (small enum set)
  - `extractPromptEvents` → census classification
  - `extractSettingsFields` (user) → census classification
  - `extractSkillFrontmatter` → census classification

**Add**:
- `collectObjectKeySets(ast)` — walk AST, collect object expression key sets (3-150 keys, deduplicated)
- `classifyByOverlap(sets, knownValues, options)` — score by Jaccard-like formula, pick best match
- `parseToolsDts(dtsContent)` — extract tool names from sdk-tools.d.ts with name mapping
- `validateContracts(rawExtracted, previousContracts)` — CI gate logic on pre-merge values

### CI Workflows

**`.github/workflows/release.yml`**:
- Add `FORCE_CONTRACTS` as a `workflow_dispatch` input (boolean, default false)
- Contract validation runs as part of the extract step; failure stops the pipeline

**`.woodpecker/release.yml`**:
- Add `FORCE_CONTRACTS` as a pipeline variable
- Same gate logic in the build step

## Testing

- Unit tests for `collectObjectKeySets()` with synthetic AST fragments (size filtering, dedup)
- Unit tests for `classifyByOverlap()` with known-value sets, decoy sets, and edge cases (ties, empty sets, single-value categories)
- Unit tests for `parseToolsDts()` with real sdk-tools.d.ts content and with absent/empty input
- Unit tests for `validateContracts()` threshold logic (>30% drop, 1-30% drop, no drop, force override)
- Integration test: run full extraction against current Claude Code version, verify all 13 categories produce non-empty results matching current contracts

## Out of Scope

- Changing the contracts JSON format or the generate-contracts codegen
- Changing how linters consume contracts
- Requesting upstream contract file from Anthropic (aspirational, not actionable)
