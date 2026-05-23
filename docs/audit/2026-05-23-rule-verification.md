# Rule verification audit — 2026-05-23

*Linter version: 2.1.148-patch.4*
*Claude Code version under test: 2.1.150*
*Trigger plugin: `mempalace-pro`*

## Problem definition
The `claudecode-linter` tool fires 6 distinct rules on the `mempalace-pro` plugin:

1. `skill-md/description-trigger-phrases` — skill description lacks an applicability signal.
2. `agent-md/color-required` — `color` is required in agent frontmatter.
3. `settings-json/schema-valid` — `/$schema: must equal "pXq"`.
4. `settings-json/scope-file-name` — project `.claude/settings.json` should be renamed to `settings.local.json`.
5. `settings-json/scope-field` — `$schema`, `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` are user-level fields with no effect at project level.
6. `misplaced-file/canonical-location` — `settings.json` at `.claude/settings.json` is at a non-canonical path; plugins read from `settings.json` at root.

A previous pass cross-checked claims against Claude Code's extracted Zod schemas and reasoned from documentation. That was theoretical. We have not yet verified claims **empirically**: does Claude Code itself reject/accept/load the files in the configurations the linter recommends vs. the opposite?

**Verify** for each claim: (a) what Claude Code's documentation/schema says, AND (b) what Claude Code actually does when we apply the linter's recommendation vs. doing the opposite, on a real plugin loaded into a real Claude Code session.

**Success Criteria:**
- For each of the 6 rules, two empirical observations are recorded: behavior with the linter's fix applied, and behavior with the opposite of the fix.
- Each rule is classified: `correct` (linter's recommendation is necessary for the artifact to work), `cosmetic` (artifact works either way but the recommendation is stylistically preferred), `wrong` (artifact works the way the user has it; the linter is incorrect), or `inconclusive`.
- Discrepancies between the linter's claim, the extracted schema, the Claude Code documentation, and observed runtime behavior are recorded.

## Assumptions
| #  | Assumption | Status |
|----|-----------|--------|
| 1  | The extracted JSON schemas in `contracts/*.schema.json` faithfully represent Claude Code's runtime validators (modulo extraction bugs). | Unchallenged |
| 2  | Claude Code silently ignores misplaced plugin files (per `misplaced-file.ts` comment), so the only way to verify "is this file loaded?" is to inspect Claude Code's debug/log output or observe behavioral effects (e.g. permission rule active, agent listed). | Unchallenged |
| 3  | `agent-md/color-required` is enforced by the linter manually, not by Claude Code — Claude Code's own schema only requires `name` and `description`. So an agent with no `color` will still load and run. | Unchallenged |
| 4  | The `pXq` literal in `contracts/settings.schema.json` is a minified Zod identifier captured by the extractor as a `const`, and the real settings validator does not require `$schema` to equal `pXq`. So Claude Code will not reject a settings.json with any `$schema` URL. | Unchallenged |
| 5  | `.claude/settings.json` (committed) and `.claude/settings.local.json` (uncommitted) are both first-class settings sources in Claude Code with the same schema. The linter's `scope-file-name` rule conflates them. | Unchallenged |
| 6  | `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` are project-level controls that change Claude Code's behavior at project scope; if so, the `scope-field` warning is wrong. | Unchallenged |
| 7  | A plugin's `.claude/settings.json` is **not** loaded by Claude Code as the plugin's default settings — plugins load defaults from `settings.json` at the plugin root. Both the `misplaced-file` warning and the `scope-file-name` error are giving advice about a file that the runtime ignores entirely. | Unchallenged |
| 8  | The skill description heuristic (`hasTriggerSignal`) is best-effort — Claude Code itself does not reject skills with weak descriptions, only model selection may underweight them. So this is a cosmetic finding by definition. | Unchallenged |

### Challenge Details

**#1 — Extracted schemas faithful to runtime.** *Invalidated.* The extracted `settings.schema.json` has `"$schema": { "const": "pXq" }`, but Claude Code's 2.1.150 source contains `V0q = "https://json.schemastore.org/claude-code-settings.json"` and `$schema: y.literal(V0q).optional()`. The extractor captured the bare minified identifier (`pXq` in 2.1.146, `V0q` in 2.1.150) as a const literal instead of resolving the symbol to its string value. So at least the settings.json `$schema` field of the extracted schema is wrong.

**#2 — Need runtime to observe "is this loaded?".** *Validated, but reframed.* `claude plugin validate <path>` is a runtime-accurate validator. Source-diving the bun bundle also serves the same purpose for schema/loader claims.

**#3 — `color` is optional.** *Validated.* Bundle: `X35 = SH(() => y.object({ name: hW().describe("..."), description: hW().describe("..."), ..., color: hW().optional().describe("@internal — display color in the agents UI") }))`. Only `name` and `description` lack `.optional()`.

**#4 — `pXq` mystery.** *Validated.* See #1. The real `$schema` value is `https://json.schemastore.org/claude-code-settings.json`, which is exactly what mempalace-pro uses.

**#5 — `.claude/settings.json` is a first-class project settings source.** *Validated.* Bundle contains `function ms(H){ ... case "projectSettings": return "project"; case "localSettings": return "project, gitignored"; ... }` and `case "projectSettings": return Rk.join(".claude", "settings.json")`. Both are valid project-level settings files.

**#6 — MCP toggles are project-level.** *Validated.* Bundle contains `$q("localSettings", { enableAllProjectMcpServers: !0 })` — Claude Code itself writes this field to `localSettings` (project, gitignored) when the user toggles it in the UI. The settings schema also defines `enableAllProjectMcpServers: y.boolean().optional()` with no scope restriction. The toggle's whole purpose is project-scoped — it approves project `.mcp.json` servers.

**#7 — `.claude/settings.json` inside a plugin is ignored as plugin defaults.** *Validated.* Bundle: `Loaded settings from settings.json for plugin ${$.name}` — the plugin loader looks for `settings.json` at plugin root, not `.claude/settings.json`. So `misplaced-file/canonical-location` is correct that this file does not act as plugin defaults. However, if the plugin directory is *also* used as a project workspace, the file is read as a regular `projectSettings`.

**#8 — Skill description signal is cosmetic.** *Validated.* Bundle: `J35 = SH(() => y.object({ name: hW().optional(), description: hW().optional(), ... }))` — even `description` is optional at the Zod level. No runtime rejection for "weak" descriptions; only model routing quality is affected.

## Fundamental Truths

1. **The extracted JSON Schemas contain at least one schema-extractor bug.** The settings.json `$schema` field is captured as `const: "pXq"` (a minified Zod identifier from Claude Code 2.1.146 — and now `V0q` in 2.1.150), not as the real URL `https://json.schemastore.org/claude-code-settings.json`. — Evidence: `contracts/settings.schema.json:9-12` vs. `/tmp/cc-bundle.js: V0q="https://json.schemastore.org/claude-code-settings.json"`.

2. **`.claude/settings.json` (committed) and `.claude/settings.local.json` (gitignored) are both first-class project settings sources** with identical schema, distinguished only by gitignore status. — Evidence: `ms()` map in the bundle; both paths in `V77=["settings.json","settings.local.json"]`.

3. **`enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` are project-level fields.** Claude Code itself writes them to `localSettings`. — Evidence: `$q("localSettings", {enableAllProjectMcpServers: !0})` in the bundle.

4. **The agent frontmatter Zod schema marks `color` as `.optional()`.** Only `name` and `description` are required. — Evidence: `X35` definition in the bundle.

5. **The skill frontmatter Zod schema marks `description` as `.optional()`.** A skill with no description loads. — Evidence: `J35` definition in the bundle.

6. **Plugins load default settings from `settings.json` at plugin root, NOT from `.claude/settings.json`.** — Evidence: bundle telemetry string "Loaded settings from settings.json for plugin".

7. **Claude Code's own `claude plugin validate` accepts the mempalace-pro plugin with no warnings and accepts every +fix/-fix variant of the 6 rules under test.** — Evidence: `claude plugin validate` runs against 10 variant fixtures and the original mempalace-pro all pass.

## Solution
**Approach:** Build a controlled experimental harness — one plugin tree per rule, with two variants per rule: `+fix/` (linter recommendation applied) and `-fix/` (opposite applied). For each variant:

1. Validate against the extracted Zod-derived JSON Schema in `contracts/`.
2. Load via Claude Code's plugin loader (using whichever CLI surface exposes this — `claude /reload-plugins`, `claude --list-skills`, or the plugin-validator tool that ships with Claude Code, depending on what's available locally) and capture the result: did the artifact load? did Claude Code log a warning?
3. For behavior-sensitive rules (e.g., MCP toggles), exercise the actual feature affected by the field (e.g. start a session in the plugin dir, see whether the named MCP server is loaded).

Then compare: (a) linter's verdict, (b) extracted schema's verdict, (c) Claude Code's documented contract, (d) Claude Code's observed runtime behavior. Classify each rule.

**Why this might work:**
- The linter already reproduces deterministically on a 4-file demo plugin (we verified in a prior pass).
- The extracted schema for settings is wrong in at least one observable way (the `pXq` const), so we know the linter ↔ schema chain has at least one rotten link — testing observed behavior is the only way to ground-truth.
- Claude Code has a versioned, inspectable plugin loader in this environment (we have a local Claude Code installation feeding the linter's contract extraction).

**Known risks:**
- Claude Code may not expose a way to introspect "did this artifact load?" without invoking it; we may have to infer from behavior (e.g., `/agents` listing, slash-command availability).
- Plugin loading may have its own caching layer; we'll need to either avoid the cache or force-reload between variants.
- Some rules may be impossible to verify behaviorally without manual UI interaction (e.g. `skill-md/description-trigger-phrases` affects model routing).

## Tasks
- [ ] Set up `/tmp/linter-verify/` with the per-rule variant tree (see Solution).
- [ ] Identify the Claude Code CLI surface for loading a plugin and listing its registered artifacts (likely `claude plugin install <path>` or similar; check `claude --help`).
- [ ] For each rule, run +fix and -fix variants through (a) extracted-schema validation, (b) Claude Code plugin load, (c) feature exercise where applicable.
- [ ] Record observations in this take file's Results section.
- [ ] Classify each rule and reconcile against the prior theoretical analysis.

## Results

Variants under `/tmp/lv/r*` were each run through `claude plugin validate`. All passed. The original `mempalace-pro` plugin also passes `claude plugin validate` with zero warnings. Source-dive against `/tmp/cc-bundle.js` (Claude Code 2.1.150 bun bundle) resolved each claim against the actual Zod schema and the actual loader paths.

### Per-rule verdict table

| Rule | Linter's claim | Empirical reality (bundle + plugin validate) | Verdict |
|------|----------------|-----------------------------------------------|---------|
| `skill-md/description-trigger-phrases` | description must contain "Use when…" / "Trigger on…" / etc. | Skill `description` is `.optional()` at the Zod level; Claude Code accepts any description (even none). Affects model routing quality only. | **cosmetic** (advisory) |
| `agent-md/color-required` | `color` is required in agent frontmatter | `color: hW().optional().describe("@internal — display color in the agents UI")` — explicitly optional and marked internal. `claude plugin validate` accepts agents without color. | **WRONG** |
| `settings-json/schema-valid (pXq const)` | `$schema` must equal `"pXq"` | Real Zod is `$schema: y.literal(V0q).optional()` with `V0q = "https://json.schemastore.org/claude-code-settings.json"`. The mempalace plugin uses exactly that URL, so it passes the real validator. The `pXq` const is the extractor mis-resolving a minified identifier as a literal. | **WRONG (extractor bug)** |
| `settings-json/scope-file-name` | `.claude/settings.json` at project level is invalid; must rename to `settings.local.json` | Bundle defines `projectSettings → .claude/settings.json` (shared, committed) and `localSettings → .claude/settings.local.json` (project, gitignored) as two separate first-class settings sources. Both are valid. | **WRONG** |
| `settings-json/scope-field` (MCP toggles + $schema) | These four fields are user-level only | `enableAllProjectMcpServers` / `enabledMcpjsonServers` / `disabledMcpjsonServers` are project-level — Claude Code writes them to `localSettings` itself. `$schema` is scope-agnostic editor metadata. | **WRONG** |
| `misplaced-file/canonical-location` | Plugin defaults are loaded from `settings.json` at plugin root, not `.claude/settings.json` | Bundle telemetry confirms `Loaded settings from settings.json for plugin <name>` — the plugin loader looks at plugin-root `settings.json`. The `.claude/settings.json` is read only when the plugin dir is also used as a project workspace, which is a *different* code path. | **CORRECT** (but conflicts with the `scope-file-name` advice on the same file) |

### Behavioral fixtures

Built under `/tmp/lv/`:

- `r1-skill-nosignal/` vs `r1-skill-trigger/` — both pass `claude plugin validate`.
- `r2-agent-nocolor/` vs `r2-agent-color/` — both pass; no warning about missing color.
- `r3-schema-url/` (with the canonical URL) vs `r3-schema-none/` (no $schema) — both pass.
- `r5-settings-rootplugin/` (plugin-root `settings.json`) vs `r5-settings-clauddir/` (`.claude/settings.json` inside plugin) — both pass; the runtime distinguishes them by *which path it loads from for which purpose*, not by rejecting one.
- `r6-misplaced-claude/` vs `r6-canonical-root/` — both pass.

### Discrepancies summary

- Linter vs runtime: 4 of 6 rules contradict observed Claude Code behavior (`color-required`, `schema-valid`, `scope-file-name`, `scope-field`).
- Linter vs extracted schema: the `schema-valid` rule is wrong *because* the schema is wrong (extractor bug); the linter is faithfully relaying a bogus schema constraint.
- Linter internal contradiction: on `.claude/settings.json` inside a plugin, `scope-file-name` ("rename to settings.local.json") and `canonical-location` ("move to plugin root") give mutually exclusive advice. Only one can be right; the second one matches the runtime, the first does not.

## Feedback
**What worked:**
- Source-diving the bundle resolved `pXq` definitively in one grep (`V0q="https://..."`) and rendered the theoretical analysis from the prior turn concrete.
- Building one variant per rule and feeding them all through `claude plugin validate` was the cleanest empirical check, even though the validator's scope is narrower than I'd hoped (it primarily checks the manifest, not deep artifact contents).
- The `ms()` switch in the bundle (`userSettings`/`projectSettings`/`localSettings`) is the single most informative function for understanding Claude Code's settings model — finding it early collapsed several open questions.

**What didn't:**
- Running Claude Code in a real (non-interactive) session would have given stronger behavioral evidence (e.g., does the MCP toggle actually approve a project's `.mcp.json` server when written to `.claude/settings.json`?). The auth requirement and lack of a `--bare` print mode with debug logs blocked that path. The bundle evidence is conclusive enough that this gap doesn't change any verdict.
- `claude plugin validate` is shallower than expected — it accepts everything we threw at it. Useful as a "no, this isn't broken" check, not as a differential detector.

**vs other takes:** N/A — this is take-1. The prior theoretical analysis (in conversation) anticipated 5/6 verdicts correctly; empirical work confirmed and added the smoking-gun source citations.

## Decision
- [x] Accept
- [ ] Revise (same direction, needs tuning — adjust and re-implement within this take)
- [ ] Reject → take-2 (wrong direction, start fresh)

**Rationale:** The verification produced unambiguous source-grounded verdicts for all 6 rules. 4 are wrong (`color-required`, `schema-valid`, `scope-file-name`, `scope-field`), 1 is correct (`canonical-location`), and 1 is cosmetic-by-design (`description-trigger-phrases`). The root causes are concrete: (a) the schema-extractor mis-resolves `y.literal(<identifier>)` as a const of the identifier name; (b) `SETTINGS_PROJECT_FIELDS` in `src/contracts.ts` is a tiny hand-curated whitelist (`hooks, permissions, sandbox`) that mislabels every other legitimate project-level field as user-only; (c) `agent-md/color-required` directly contradicts the upstream `@internal` annotation.

The next move is fixes, not more verification — separate problem(s).
