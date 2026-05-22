# Security Policy

## Supported Versions

Only the latest published release is supported. Install or upgrade to the
current `latest` on npm:

```bash
npm install -g claudecode-linter@latest
```

The project version-tracks Claude Code (see "Versioning" in `CLAUDE.md`):
contract-synced releases match the Claude Code version they were extracted
from, and linter-only fixes ship as pre-release patches on top. Older
versions do not receive backported fixes — the next release supersedes them.

## Security Model

claudecode-linter is a **static analyzer**. It reads and parses Claude Code
plugin and configuration artifacts (`plugin.json`, `SKILL.md`, agent/command
markdown, `hooks.json`, `mcp.json`, `settings.json`, `CLAUDE.md`, `.lsp.json`,
`monitors/monitors.json`) and validates them against schemas. It **never
executes the content it inspects**.

The threat model is "parse malicious input," not "execute untrusted code."

Verified runtime properties:

- **No code execution.** The linter contains no `eval`, no `Function`
  constructor, no `vm` module, no `child_process`, and no dynamic `import()`
  of inspected content. Hooks declared in artifacts are not run; MCP servers
  declared in artifacts are not spawned.
- **No network access at runtime.** Linting performs no outbound connections.
  (Contract extraction — a separate, development-time workflow — does fetch
  Claude Code; that path is not part of the linter CLI.)
- **No privilege escalation.** The CLI needs no elevated privileges, opens no
  daemon, and binds no socket.
- **Schema validation is bounded.** Ajv compiles only the linter's own
  bundled JSON Schemas (`contracts/*.schema.json`) — never schemas drawn from
  inspected input. Parsing is `JSON.parse` plus the `yaml` v2 parser, which is
  safe-by-default (no arbitrary type construction).

## Hardening

A security audit reviewed the linter's input-handling surface. The following
vectors were identified and fixed:

- **`--fix` / `--format` write guard.** Auto-fix and format write files back
  to disk. A symlink- and path-escape-aware guard
  (`src/utils/safe-write.ts`) ensures writes stay within the target directory
  and refuses to follow symlinks out of it.
- **Resource limits on parsing.** A 5 MiB `MAX_ARTIFACT_BYTES` cap bounds how
  much of any artifact is read, and the YAML parser is configured with an
  explicit `maxAliasCount: 100` to prevent alias-expansion ("billion laughs")
  amplification.
- **Terminal-escape sanitization.** Diagnostic output derived from inspected
  files is sanitized (`src/utils/terminal.ts`) so malicious terminal escape
  sequences in artifact content cannot manipulate the user's terminal.

## Running on Untrusted Input

Linting trusted code needs no special isolation. For untrusted plugins —
especially when using `--fix`, which writes to disk — run the linter
sandboxed. The linter is verified to run correctly fully confined: no
network, read-only root filesystem, all Linux capabilities dropped,
`no-new-privileges`, a non-root UID, and only the target directory mounted.

The "Running on untrusted plugins" section of `README.md` gives four verified
recipes — Docker read-only (lint), Docker read-write (`--fix`), and the
equivalent `bubblewrap` (`bwrap`) read-only and read-write invocations. Under
`bwrap`, `--unshare-all` removes network access and nothing is writable except,
for `--fix`, the target directory; `--ro-bind / /` can be narrowed to explicit
per-path read binds for least-read-authority.

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub's private
vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Provide a description, reproduction steps, and the affected version.

Please do not open a public issue for security reports.
