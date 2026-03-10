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
	const items = (values ?? []).map((v) => `  ${JSON.stringify(v)},`).join("\n");
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
];

writeFileSync(outputPath, lines.join("\n"));
console.log(`Generated ${outputPath}`);
