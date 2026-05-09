import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AGENT_FRONTMATTER,
	AGENT_MODELS,
	AGENT_COLORS,
	TOOLS,
	PLUGIN_SUBAGENT_BLOCKED_TOOLS,
} from "../contracts.js";
import type {
	Linter,
	LintDiagnostic,
	LinterConfig,
	Severity,
} from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

function findPluginRoot(agentFilePath: string): string | null {
	let dir = dirname(agentFilePath);
	for (let i = 0; i < 10; i++) {
		if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function loadJson(p: string): unknown {
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
}

function loadPluginName(pluginRoot: string): string | null {
	const j = loadJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
	if (j && typeof j === "object" && j !== null && "name" in j) {
		const n = (j as Record<string, unknown>).name;
		return typeof n === "string" ? n : null;
	}
	return null;
}

function loadMcpServerNames(pluginRoot: string): Set<string> {
	const j = loadJson(join(pluginRoot, ".mcp.json"));
	const out = new Set<string>();
	if (
		j &&
		typeof j === "object" &&
		j !== null &&
		"mcpServers" in j &&
		typeof (j as Record<string, unknown>).mcpServers === "object" &&
		(j as Record<string, unknown>).mcpServers !== null
	) {
		for (const k of Object.keys(
			(j as { mcpServers: Record<string, unknown> }).mcpServers,
		)) {
			out.add(k);
		}
	}
	return out;
}

function parseToolsField(v: unknown): string[] {
	if (typeof v !== "string") return [];
	return v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

interface RuleDef {
	id: string;
	defaultSeverity: Severity;
}

const RULES: RuleDef[] = [
	{ id: "agent-md/valid-frontmatter", defaultSeverity: "error" },
	{ id: "agent-md/name-required", defaultSeverity: "error" },
	{ id: "agent-md/name-format", defaultSeverity: "error" },
	{ id: "agent-md/description-required", defaultSeverity: "error" },
	{ id: "agent-md/description-examples", defaultSeverity: "warning" },
	{ id: "agent-md/model-required", defaultSeverity: "error" },
	{ id: "agent-md/model-valid", defaultSeverity: "warning" },
	{ id: "agent-md/color-required", defaultSeverity: "warning" },
	{ id: "agent-md/color-valid", defaultSeverity: "warning" },
	{ id: "agent-md/system-prompt-present", defaultSeverity: "error" },
	{ id: "agent-md/system-prompt-length", defaultSeverity: "warning" },
	{ id: "agent-md/system-prompt-second-person", defaultSeverity: "info" },
	{ id: "agent-md/no-unknown-frontmatter", defaultSeverity: "info" },
	{ id: "agent-md/known-tools", defaultSeverity: "warning" },
	{ id: "agent-md/mcp-tools-resolve", defaultSeverity: "error" },
	{ id: "agent-md/plugin-subagent-blocked-tools", defaultSeverity: "warning" },
];

function diag(
	config: LinterConfig,
	filePath: string,
	ruleId: string,
	defaultSeverity: Severity,
	message: string,
	line?: number,
	column?: number,
): LintDiagnostic | null {
	if (!isRuleEnabled(config, ruleId)) return null;
	return {
		rule: ruleId,
		severity: getRuleSeverity(config, ruleId, defaultSeverity),
		message,
		file: filePath,
		line,
		column,
	};
}

export const agentMdLinter: Linter = {
	artifactType: "agent-md",

	lint(
		filePath: string,
		content: string,
		config: LinterConfig,
	): LintDiagnostic[] {
		const diagnostics: LintDiagnostic[] = [];
		const push = (d: LintDiagnostic | null) => {
			if (d) diagnostics.push(d);
		};

		const fm = parseFrontmatter(content);

		if (!fm.valid) {
			push(
				diag(
					config,
					filePath,
					"agent-md/valid-frontmatter",
					"error",
					fm.error ?? "Invalid frontmatter",
				),
			);
			return diagnostics;
		}

		// name
		if (!("name" in fm.data) || typeof fm.data.name !== "string") {
			push(
				diag(
					config,
					filePath,
					"agent-md/name-required",
					"error",
					'"name" is required in frontmatter',
				),
			);
		} else {
			const name = fm.data.name;
			if (
				!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) ||
				name.length < 3 ||
				name.length > 50
			) {
				push(
					diag(
						config,
						filePath,
						"agent-md/name-format",
						"error",
						`"name" must be 3-50 chars, lowercase alphanumeric + hyphens (got "${name}")`,
					),
				);
			}
		}

		// description
		if (
			!("description" in fm.data) ||
			typeof fm.data.description !== "string"
		) {
			push(
				diag(
					config,
					filePath,
					"agent-md/description-required",
					"error",
					'"description" is required in frontmatter',
				),
			);
		} else {
			if (!/<example>/i.test(fm.data.description)) {
				push(
					diag(
						config,
						filePath,
						"agent-md/description-examples",
						"warning",
						"Description should include <example> blocks for triggering",
					),
				);
			}
		}

		// model
		if (!("model" in fm.data) || typeof fm.data.model !== "string") {
			push(
				diag(
					config,
					filePath,
					"agent-md/model-required",
					"error",
					'"model" is required in frontmatter',
				),
			);
		} else if (
			!AGENT_MODELS.has(fm.data.model) &&
			!fm.data.model.startsWith("claude-")
		) {
			push(
				diag(
					config,
					filePath,
					"agent-md/model-valid",
					"warning",
					`"model" must be one of: ${[...AGENT_MODELS].join(", ")} or a versioned claude-* model ID (got "${fm.data.model}")`,
				),
			);
		}

		// color
		if (!("color" in fm.data) || typeof fm.data.color !== "string") {
			push(
				diag(
					config,
					filePath,
					"agent-md/color-required",
					"warning",
					'"color" is required in frontmatter',
				),
			);
		} else if (!AGENT_COLORS.has(fm.data.color)) {
			push(
				diag(
					config,
					filePath,
					"agent-md/color-valid",
					"warning",
					`"color" must be one of: ${[...AGENT_COLORS].join(", ")} (got "${fm.data.color}")`,
				),
			);
		}

		// unknown frontmatter fields
		const knownFields = new Set([...AGENT_FRONTMATTER, "name", "color"]);
		for (const key of Object.keys(fm.data)) {
			if (!knownFields.has(key)) {
				push(
					diag(
						config,
						filePath,
						"agent-md/no-unknown-frontmatter",
						"info",
						`Unknown frontmatter field "${key}"`,
					),
				);
			}
		}

		// system prompt (body)
		const body = fm.body.trim();
		if (!body) {
			push(
				diag(
					config,
					filePath,
					"agent-md/system-prompt-present",
					"error",
					"Agent must have a system prompt (body after frontmatter)",
				),
			);
		} else {
			if (body.length < 20) {
				push(
					diag(
						config,
						filePath,
						"agent-md/system-prompt-length",
						"warning",
						`System prompt is very short (${body.length} chars, recommended >= 20)`,
						fm.bodyStartLine,
					),
				);
			}
			if (!/\byou\b/i.test(body)) {
				push(
					diag(
						config,
						filePath,
						"agent-md/system-prompt-second-person",
						"info",
						'System prompt should use second person ("You are...", "You will...")',
						fm.bodyStartLine,
					),
				);
			}
		}

		// tools
		const declaredTools = parseToolsField(fm.data.tools);
		if (declaredTools.length > 0) {
			const pluginRoot = findPluginRoot(filePath);
			const pluginName = pluginRoot ? loadPluginName(pluginRoot) : null;
			const mcpServers = pluginRoot
				? loadMcpServerNames(pluginRoot)
				: new Set<string>();

			for (const t of declaredTools) {
				if (t.startsWith("mcp__")) {
					// Two valid shapes:
					//   mcp__plugin_<plugin>_<server>__<tool>   plugin-namespaced
					//   mcp__<server>__<tool>                   user-config (non-plugin)
					const ns = t.match(/^mcp__plugin_([a-z0-9-]+)_([a-z0-9-]+)__(.+)$/);
					const bare = t.match(/^mcp__([a-z0-9-]+)__(.+)$/);

					if (ns) {
						const declaredPlugin = ns[1];
						const declaredServer = ns[2];
						if (pluginName && declaredPlugin !== pluginName) {
							push(
								diag(
									config,
									filePath,
									"agent-md/mcp-tools-resolve",
									"error",
									`Tool "${t}" references plugin "${declaredPlugin}", but this plugin is named "${pluginName}".`,
								),
							);
						}
						if (
							pluginRoot &&
							mcpServers.size > 0 &&
							!mcpServers.has(declaredServer)
						) {
							push(
								diag(
									config,
									filePath,
									"agent-md/mcp-tools-resolve",
									"error",
									`Tool "${t}" references MCP server "${declaredServer}", but .mcp.json declares: [${[...mcpServers].join(", ")}].`,
								),
							);
						}
					} else if (bare && pluginRoot) {
						const server = bare[1];
						const rest = bare[2];
						if (mcpServers.has(server)) {
							push(
								diag(
									config,
									filePath,
									"agent-md/mcp-tools-resolve",
									"error",
									`Tool "${t}" uses bare "mcp__<server>__<tool>" form, but this is a plugin (${pluginName ?? "unknown name"}). Plugin agents must use the namespaced form: "mcp__plugin_${pluginName ?? "<plugin>"}_${server}__${rest}".`,
								),
							);
						}
					}
					continue;
				}
				if (!TOOLS.has(t)) {
					push(
						diag(
							config,
							filePath,
							"agent-md/known-tools",
							"warning",
							`Unknown built-in tool "${t}" in tools: field. Valid: ${[...TOOLS].sort().join(", ")}.`,
						),
					);
				}
				if (pluginRoot && PLUGIN_SUBAGENT_BLOCKED_TOOLS.has(t)) {
					push(
						diag(
							config,
							filePath,
							"agent-md/plugin-subagent-blocked-tools",
							"warning",
							`Tool "${t}" is declared but does NOT reach plugin subagents at runtime — known Claude Code bug (https://github.com/anthropics/claude-code/issues/52055). The agent will silently lack this tool. For local file ops, use Bash with rg/find, or dispatch the built-in Explore subagent.`,
						),
					);
				}
			}
		}

		return diagnostics;
	},
};

export { RULES as AGENT_MD_RULES };
