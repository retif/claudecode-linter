# TODO

## Fragile contract extraction from Claude Code bundles

**Problem:** The extractor (`scripts/extract-contracts.ts`) uses hardcoded AST patterns and regex to find contract values in Claude Code's minified `cli.js` bundle. When Claude Code updates their bundle structure, these patterns silently break — returning empty arrays instead of the expected values.

**Affected extractors and their fragile anchors:**

| Extractor | Anchor pattern | Risk |
|-----------|---------------|------|
| `extractPluginJsonFields` | `.describe("Unique identifier for the plugin"` | String literal match |
| `extractAgentFrontmatterFields` | `.describe("Model to use for this agent"` | String literal match |
| `extractAgentModelEnum` | `I.enum([...]).optional().describe("Model to use for this agent"` | Regex on Zod shape |
| `extractCommandFrontmatterFields` | `.describe("Path to command markdown file"` | String literal match |
| `extractMcpServerFields` | `I.literal("stdio")`, `I.literal("sse")`, `I.literal("http")` | Multiple anchors |
| `extractHookTypes` | `I.literal("command").describe("...hook type")` | Regex on Zod shape |
| `extractPromptEvents` | `hookEventName:I.literal("...")...permissionDecision` | Complex regex |
| `extractSettingsFields` | `.describe("JSON Schema reference for Claude Code settings")` | String literal match |

**Current workaround:** `mergeWithPrevious` in the extract script merges newly extracted values with previously committed contracts, so values degrade gracefully instead of disappearing. This prevents CI failures but means stale values accumulate and removed fields are never cleaned up.

**What broke in v2.1.72:** Most Zod-based extractors returned empty results. The `I.object({` patterns and `.describe(...)` anchors no longer matched, suggesting Claude Code restructured their Zod schemas or the bundler changed how they're serialized.

**Potential solutions:**

1. **Runtime extraction** — Instead of AST parsing, actually `require()` the CLI module and inspect exported schemas/types at runtime. More reliable but requires understanding the module's export structure.

2. **Diff-based extraction** — Download two consecutive versions, diff them, and use the stable parts as anchors. Adapts to gradual changes but breaks on major restructures.

3. **Fuzzy matching** — Instead of exact string anchors, use heuristics (e.g., "find the Zod object containing both `name` and `description` fields near a plugin-related context"). More resilient but risks false positives.

4. **Upstream contract** — Request that Claude Code publishes a stable contract/schema file (e.g., `contracts.json` in the npm package). This would eliminate the need for extraction entirely.

5. **Validation-only fallback** — When extraction finds fewer values than before, log a warning but keep validating with the previous known-good set. Accept that the linter may lag behind by one version.
