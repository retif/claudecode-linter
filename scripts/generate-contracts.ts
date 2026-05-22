#!/usr/bin/env tsx
/**
 * Reads contracts/claude-code-contracts.json and generates src/contracts.ts.
 *
 * Run: npm run generate-contracts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dirname!, "..");
const inputPath = join(rootDir, "contracts", "claude-code-contracts.json");
const outputPath = join(rootDir, "src", "contracts.ts");

const data = JSON.parse(readFileSync(inputPath, "utf8"));
const c = data.contracts;

function setLiteral(name: string, values: string[] | undefined): string {
	const items = (values ?? []).map((v) => `\t${JSON.stringify(v)},`).join("\n");
	return `export const ${name} = new Set<string>([\n${items}\n]);`;
}

const lines = [
	"// Auto-generated from contracts/claude-code-contracts.json",
	`// Claude Code v${data.version} — extracted ${data.extractedAt}`,
	"// Do not edit manually. Run: npm run generate-contracts",
	"",
	setLiteral("TOOLS", c.tools),
	"",
	setLiteral("HOOK_EVENTS", c.hookEvents),
	"",
	setLiteral("HOOK_TYPES", c.hookTypes),
	"",
	setLiteral("PROMPT_EVENTS", c.promptEvents),
	"",
	setLiteral("AGENT_COLORS", c.agentColors),
	"",
	setLiteral("AGENT_MODELS", c.agentModels),
	"",
	setLiteral("PLUGIN_JSON_FIELDS", c.pluginJsonFields),
	"",
	setLiteral("AGENT_FRONTMATTER", c.agentFrontmatter),
	"",
	setLiteral("COMMAND_FRONTMATTER", c.commandFrontmatter),
	"",
	setLiteral("MCP_SERVER_FIELDS", c.mcpServerFields),
	"",
	setLiteral("SKILL_FRONTMATTER", c.skillFrontmatter),
	"",
	setLiteral("SETTINGS_USER_FIELDS", c.settingsUserFields),
	"",
	setLiteral("SETTINGS_PROJECT_FIELDS", c.settingsProjectFields),
	"",
	"// Allowed sub-keys of the settings `permissions` object.",
	setLiteral("PERMISSIONS_FIELDS", c.permissionsFields),
	"",
	"// Allowed sub-keys of the settings `sandbox` object.",
	setLiteral("SANDBOX_FIELDS", c.sandboxFields),
	"",
	"// Allowed sub-keys of `sandbox.network` and `sandbox.filesystem`.",
	setLiteral("SANDBOX_NETWORK_FIELDS", c.sandboxNetworkFields),
	"",
	setLiteral("SANDBOX_FILESYSTEM_FIELDS", c.sandboxFilesystemFields),
	"",
	"// Valid values for `permissions.defaultMode`.",
	setLiteral("PERMISSION_MODES", c.permissionModes),
	"",
	"// Hand-curated denylist of tools declared in agent frontmatter that never",
	"// reach plugin-defined subagents at runtime. Source: tracked upstream bugs",
	"//   https://github.com/anthropics/claude-code/issues/52055",
	"//   https://github.com/anthropics/claude-code/issues/52004",
	setLiteral("PLUGIN_SUBAGENT_BLOCKED_TOOLS", c.pluginSubagentBlockedTools),
	"",
	"// Hand-curated named values for the frontmatter `effort` field. The Zod",
	"// schema types `effort` as a permissive scalar; the field's own describe()",
	'// string in the Claude Code bundle reads: "Thinking effort for the model:',
	"// `low`, `medium`, `high`, `max`, or an integer." — so a string `effort`",
	"// must be one of these, and a numeric `effort` must be an integer. (The",
	"// runtime effortLevel enum also has `xhigh`, but the frontmatter describe",
	"// string deliberately omits it; we follow the frontmatter contract.)",
	setLiteral("EFFORT_LEVELS", ["low", "medium", "high", "max"]),
	"",
];

writeFileSync(outputPath, lines.join("\n"));
console.log(`Generated ${outputPath}`);
