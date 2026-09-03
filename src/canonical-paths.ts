import { minimatch } from "minimatch";

/**
 * Files whose basename is reserved for a specific Claude Code plugin
 * artifact and which Claude Code only reads from a single canonical
 * location. A file with the same basename at any other path is
 * silently ignored — no warning, no error, the artifact just doesn't
 * register.
 *
 * This table powers the misplaced-file linter: scan a plugin tree
 * for known basenames, flag anything not at its expected path.
 *
 * `expectedPath` is the path relative to the plugin root. If
 * `expectedPattern` is set, it's a minimatch glob — used for
 * artifacts where the path has a variable segment
 * (`skills/<name>/SKILL.md`).
 *
 * `projectLocalPatterns` lists the *other* locations Claude Code
 * genuinely reads the artifact from when the tree is also a project
 * of its own — `.claude/skills/<name>/SKILL.md` and
 * `.claude/settings.json`. A repo can legitimately be both a plugin
 * and a project, so these are not misplacements: the two locations
 * mean different things (a plugin skill ships to every install, a
 * project-local one is for this repo's own contributors), and the
 * misplaced-file remedy — "move it to `skills/<name>/`" — would
 * publish a contributor-only artifact to every install. Deliberately
 * an allow-list of documented paths, not a blanket `.claude/**`
 * exemption: `.claude/skills/SKILL.md` (no `<name>` directory) is
 * read by nothing and is still flagged.
 */
export interface CanonicalArtifact {
	basename: string;
	expectedPath?: string;
	expectedPattern?: string;
	projectLocalPatterns?: string[];
	description: string;
}

export const CANONICAL_ARTIFACTS: CanonicalArtifact[] = [
	{
		basename: "plugin.json",
		expectedPath: ".claude-plugin/plugin.json",
		description: "plugin manifest",
	},
	{
		basename: "marketplace.json",
		expectedPath: ".claude-plugin/marketplace.json",
		description: "marketplace manifest",
	},
	{
		basename: "hooks.json",
		expectedPath: "hooks/hooks.json",
		description: "plugin hooks config",
	},
	{
		basename: "SKILL.md",
		expectedPattern: "skills/*/SKILL.md",
		projectLocalPatterns: [".claude/skills/*/SKILL.md"],
		description: "skill manifest",
	},
	{
		basename: ".mcp.json",
		expectedPath: ".mcp.json",
		description: "plugin MCP server definitions",
	},
	{
		basename: ".lsp.json",
		expectedPath: ".lsp.json",
		description: "plugin LSP server configurations",
	},
	{
		basename: "monitors.json",
		expectedPath: "monitors/monitors.json",
		description: "plugin background-monitor declarations",
	},
	{
		basename: "settings.json",
		expectedPath: "settings.json",
		projectLocalPatterns: [".claude/settings.json"],
		description: "plugin default settings",
	},
];

/**
 * True when `relPath` (relative to the plugin root, POSIX-separated)
 * is a location Claude Code actually reads `entry` from — either the
 * plugin-canonical path/pattern, or one of the project-local paths.
 * Everything else is a misplacement.
 */
export function isCanonicalLocation(
	relPath: string,
	entry: CanonicalArtifact,
): boolean {
	const rel = relPath.split("\\").join("/");
	if (entry.expectedPattern) {
		if (minimatch(rel, entry.expectedPattern)) return true;
	} else if (entry.expectedPath !== undefined && rel === entry.expectedPath) {
		return true;
	}
	for (const pattern of entry.projectLocalPatterns ?? []) {
		if (minimatch(rel, pattern)) return true;
	}
	return false;
}
