# Implementation Plan: Missing Features

## Task Groups

### 1. CLI Flag Wiring (index.ts)
- Wire `--enable <rules>` and `--disable <rules>` flags to `mergeCliRules()`
- Add `--rule <rule>` flag to run a single rule
- Add `--list-rules` flag to print all available rules with severity defaults
- Add `--fix-dry-run` flag to show what would change without writing
- Exit code 2 for config/fatal errors (wrap action in try/catch)

### 2. Fix classifyFile() (discovery.ts)
- Recognize bare `mcp.json` at any location (not just under `.claude/`)

### 3. JSON Fixers (new files)
- `src/fixers/hooks-json.ts` — sort hook entries by event name, normalize structure
- `src/fixers/mcp-json.ts` — sort server keys alphabetically, sort fields within each server
- `src/fixers/settings-json.ts` — sort top-level keys, sort permission arrays, remove unknown fields

### 4. Claude-MD Fixer (new file)
- `src/fixers/claude-md.ts` — strip trailing whitespace, ensure trailing newline, ensure blank line before headings

### 5. Frontmatter Fixer Cleanup
- Remove the no-op colon-quoting block in `src/fixers/frontmatter.ts`

### 6. Register New Fixers (index.ts)
- Add hooks-json, mcp-json, settings-json, claude-md to the FIXERS map

### 7. Ignore Support
- Add `--ignore <glob>` CLI flag
- Load `.claude-lint-ignore` file (gitignore-style patterns)
- Filter discovered artifacts before linting

### 8. Tests for All New Features
- Tests for new CLI flags (enable/disable, rule, list-rules)
- Tests for each new fixer
- Tests for ignore support
- Tests for classifyFile mcp.json fix

## Implementation Order

Tasks 1-5 are independent and can be parallelized.
Task 6 depends on tasks 3+4 (new fixers must exist before registering).
Task 7 is independent.
Task 8 depends on everything else.
