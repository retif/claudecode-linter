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
 */
export interface CanonicalArtifact {
	basename: string;
	expectedPath?: string;
	expectedPattern?: string;
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
		description: "plugin default settings",
	},
];
