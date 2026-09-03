import { TOOLS } from "../contracts.js";

/**
 * Validation policy for a built-in tool name written by a human — in a
 * command's or skill's `allowed-tools`, an agent's `tools:`, or a
 * settings.json permission rule.
 *
 * `TOOLS` is extracted from a *published* Claude Code release, but the running
 * harness gains tools between releases and exposes some that appear in no
 * shipped type surface at all (`ListAgents`, `DesignSync`, `EndConversation`
 * are all callable on 2.1.259 yet absent from the extracted registry). Treating
 * the registry as an exhaustive allowlist therefore warns on correct files, and
 * will keep doing so however often the registry is refreshed — the linter is
 * structurally behind the harness.
 *
 * So the registry is used as a *hint*, not a gate:
 *
 *   - a known tool passes;
 *   - a name that cannot be a tool (wrong shape) is reported;
 *   - a name that is a near-miss of a known tool — the typo case the rule
 *     exists to catch — is reported, with the suggestion;
 *   - a well-formed name that resembles nothing known is accepted, on the
 *     assumption that the harness knows tools the registry does not.
 */

/** Tool names are PascalCase identifiers: `Bash`, `WebFetch`, `LSP`. */
const TOOL_NAME_SHAPE = /^[A-Z][A-Za-z0-9]*$/;

/** `Tool` or `Tool(specifier)` — the permission-rule form. */
const TOOL_ENTRY_SHAPE = /^([^()]+)(?:\((.*)\))?$/s;

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition),
 * so a swapped pair — `Bahs` for `Bash` — costs 1 rather than 2.
 */
export function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const d: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = 0; i <= m; i++) d[i][0] = i;
	for (let j = 0; j <= n; j++) d[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(
				d[i - 1][j] + 1,
				d[i][j - 1] + 1,
				d[i - 1][j - 1] + cost,
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
			}
		}
	}
	return d[m][n];
}

/**
 * The closest known tool to `name`, or null when nothing is close enough to be
 * a plausible typo. Requires both an absolute cap (≤ 2 edits) and a relative
 * one (the edits must be less than half the name), so `ListMcpResourcesTool`
 * is not read as a misspelling of `ListMcpResources`.
 */
export function nearestKnownTool(name: string): string | null {
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const tool of TOOLS) {
		const d = editDistance(name, tool);
		if (d < bestDistance) {
			bestDistance = d;
			best = tool;
		}
	}
	if (best === null) return null;
	if (bestDistance > 2) return null;
	if (bestDistance * 2 >= name.length) return null;
	return best;
}

/**
 * Why `entry` cannot be a tool reference, or null when it is acceptable.
 *
 * `entry` is the raw string as written — a bare tool name, or the
 * `Tool(specifier)` form, which `allowed-tools` and permission rules share.
 * Only the base name is checked here; specifier grammar is a separate rule.
 */
export function toolNameProblem(entry: string): string | null {
	const raw = entry.trim();
	if (!raw) return "Empty tool name";

	// mcp__<server>__<tool> is resolved at runtime — nothing to check against.
	if (raw.startsWith("mcp__")) return null;

	const match = TOOL_ENTRY_SHAPE.exec(raw);
	const name = match ? match[1].trim() : raw;

	if (TOOLS.has(name)) return null;

	if (!TOOL_NAME_SHAPE.test(name)) {
		for (const tool of TOOLS) {
			if (tool.toLowerCase() === name.toLowerCase()) {
				return `Unknown tool "${name}" — did you mean "${tool}"?`;
			}
		}
		return `Invalid tool name "${name}" — tool names are PascalCase identifiers`;
	}

	const suggestion = nearestKnownTool(name);
	if (suggestion) {
		return `Unknown tool "${name}" — did you mean "${suggestion}"?`;
	}

	// Well-formed and unlike anything known: assume the harness has a tool the
	// extracted registry does not list, rather than warn on a correct file.
	return null;
}
