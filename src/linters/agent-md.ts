import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AGENT_MODELS,
	AGENT_COLORS,
	TOOLS,
	PERMISSION_MODES,
	PLUGIN_SUBAGENT_BLOCKED_TOOLS,
} from "../contracts.js";
import { invalidEffortReason } from "../utils/effort.js";
import {
	formatAjvError,
	loadAgentFrontmatterSchema,
	summarizeErrors,
} from "../plugin-schema.js";
import type {
	Linter,
	LintDiagnostic,
	LinterConfig,
	Severity,
} from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import {
	artifactLabel,
	classifyUnknownFrontmatterKey,
} from "../utils/frontmatter-keys.js";
import { toolNameProblem } from "../utils/tool-names.js";

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

/**
 * Plugin names this plugin declares in `plugin.json` `dependencies`.
 *
 * A plugin that depends on another may grant its agents that plugin's MCP
 * tools, and they resolve at runtime — `anxious` declares
 * `{"name": "cluster", ...}` and its issuer/steward agents call
 * `mcp__plugin_cluster_gitea-tools__*` successfully today. Without reading
 * `dependencies`, mcp-tools-resolve cannot tell that declared grant apart from
 * a typo, and reported all 10 of them as errors
 * (oleks/claudecode-linter#13).
 *
 * Both the object form (`[{"name": "cluster", "version": ">=0.34.2"}]`) and a
 * bare-string form are accepted, so a shape variation cannot silently turn the
 * check back into a false positive.
 */
function loadPluginDependencies(pluginRoot: string): Set<string> {
	const j = loadJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
	const out = new Set<string>();
	if (!j || typeof j !== "object") return out;
	const deps = (j as Record<string, unknown>).dependencies;
	if (!Array.isArray(deps)) return out;
	for (const d of deps) {
		if (typeof d === "string") {
			out.add(d);
		} else if (d && typeof d === "object" && typeof (d as Record<string, unknown>).name === "string") {
			out.add((d as { name: string }).name);
		}
	}
	return out;
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
	{ id: "agent-md/schema-valid", defaultSeverity: "error" },
	{ id: "agent-md/name-required", defaultSeverity: "error" },
	{ id: "agent-md/name-format", defaultSeverity: "error" },
	{ id: "agent-md/description-required", defaultSeverity: "error" },
	{ id: "agent-md/description-routing-guidance", defaultSeverity: "warning" },
	{ id: "agent-md/model-required", defaultSeverity: "error" },
	{ id: "agent-md/model-valid", defaultSeverity: "warning" },
	{ id: "agent-md/permission-mode-valid", defaultSeverity: "warning" },
	{ id: "agent-md/effort-valid", defaultSeverity: "warning" },
	{ id: "agent-md/max-turns-valid", defaultSeverity: "warning" },
	// agent-md/color-required removed in gitea#3 — Claude Code marks `color`
	// as `.optional()` and `@internal`. The remaining `color-valid` rule still
	// enforces the value set when an author opts in.
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

		// schema-valid — structural validation against the JSON Schema
		// auto-extracted from Claude Code's agent frontmatter Zod validator.
		// The hand-written rules below add Claude-Code-specific advice with
		// friendlier messages (model-valid / color-valid re-check fields the
		// schema also covers — that minimal double-reporting is acceptable).
		// The extracted schema is intentionally permissive about unknown
		// frontmatter keys (Claude Code still loads the agent), so those are
		// NOT reported here — agent-md/no-unknown-frontmatter handles them.
		// Skipped silently if the schema bundle isn't shipped with this install.
		if (isRuleEnabled(config, "agent-md/schema-valid")) {
			const compiled = loadAgentFrontmatterSchema();
			if (compiled) {
				const ok = compiled.validate(fm.data);
				if (!ok && compiled.validate.errors) {
					for (const err of summarizeErrors(compiled.validate.errors)) {
						push(
							diag(
								config,
								filePath,
								"agent-md/schema-valid",
								"error",
								formatAjvError(err),
							),
						);
					}
				}
			}
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
				!/^[a-z][a-z0-9-]*[a-z0-9]?$/.test(name) ||
				name.length < 2 ||
				name.length > 50
			) {
				push(
					diag(
						config,
						filePath,
						"agent-md/name-format",
						"error",
						`"name" must be 2-50 chars, lowercase alphanumeric + hyphens (got "${name}")`,
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
			// An agent description must convey *when to route to it*. Three
			// forms satisfy that: <example> blocks (the upstream few-shot
			// convention), an explicit routing-triggers block, or prose that
			// states the triggers. Warn only when the description does none.
			const desc = fm.data.description;
			const hasExamples = /<example>/i.test(desc);
			const hasRoutingTriggers = /ROUTING TRIGGERS/i.test(desc);
			const hasTriggerProse =
				/\b(use (it |this )?(for|when|to)\b|use this (agent|skill)|trigger(s|ed)? (on|by|when)|when the user|for any (task|request|work)|invoke (this|when))/i.test(
					desc,
				);
			if (!hasExamples && !hasRoutingTriggers && !hasTriggerProse) {
				push(
					diag(
						config,
						filePath,
						"agent-md/description-routing-guidance",
						"warning",
						"Description should convey when to route to this agent — via <example> blocks, a routing-triggers block (<!-- BEGIN ROUTING TRIGGERS -->…<!-- END ROUTING TRIGGERS -->), or prose stating the triggers",
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

		// permissionMode — typed as a permissive scalar by the Zod schema;
		// at runtime only the PERMISSION_MODES values take effect.
		if ("permissionMode" in fm.data) {
			const pm = fm.data.permissionMode;
			if (typeof pm !== "string" || !PERMISSION_MODES.has(pm)) {
				push(
					diag(
						config,
						filePath,
						"agent-md/permission-mode-valid",
						"warning",
						`"permissionMode" must be one of: ${[...PERMISSION_MODES].join(", ")} (got ${JSON.stringify(pm)})`,
					),
				);
			}
		}

		// effort — Zod types it as a permissive scalar; the field's describe()
		// string restricts it to a named level or an integer.
		if ("effort" in fm.data) {
			const reason = invalidEffortReason(fm.data.effort);
			if (reason) {
				push(
					diag(config, filePath, "agent-md/effort-valid", "warning", reason),
				);
			}
		}

		// maxTurns — Zod accepts a string / float; only a positive integer
		// is a meaningful turn budget.
		if ("maxTurns" in fm.data) {
			const mt = fm.data.maxTurns;
			if (typeof mt !== "number" || !Number.isInteger(mt) || mt <= 0) {
				push(
					diag(
						config,
						filePath,
						"agent-md/max-turns-valid",
						"warning",
						`"maxTurns" must be a positive integer (got ${JSON.stringify(mt)})`,
					),
				);
			}
		}

		// color — optional per Claude Code's agent frontmatter Zod schema
		// (`color: hW().optional().describe("@internal — display color in the
		// agents UI")`). Only validate the value if the user set one; never
		// require it. The `color-required` rule (gitea#3) is kept on disk for
		// users who explicitly opted in via .claudecode-lint.yaml, but defaults
		// to off because requiring an @internal display field misled users.
		if ("color" in fm.data) {
			if (typeof fm.data.color !== "string") {
				push(
					diag(
						config,
						filePath,
						"agent-md/color-valid",
						"warning",
						'"color" must be a string when set',
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
		}

		// Frontmatter keys: only flag cross-artifact misplacement. A key valid
		// for a *different* markdown artifact (e.g. a skill-only key on an
		// agent) gets an info; a key valid for no artifact stays silent.
		// "name"/"color" are agent-valid but absent from the contract set.
		const extraKnown = new Set(["name", "color"]);
		for (const key of Object.keys(fm.data)) {
			const cls = classifyUnknownFrontmatterKey(key, "agent", extraKnown);
			if (cls?.kind === "owned-by-other" && cls.owner) {
				push(
					diag(
						config,
						filePath,
						"agent-md/no-unknown-frontmatter",
						"info",
						`"${key}" is ${artifactLabel(cls.owner)} frontmatter — Claude Code ignores it on an agent`,
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
			const dependencies = pluginRoot
				? loadPluginDependencies(pluginRoot)
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
						// A tool from a plugin this one DEPENDS on is a declared
						// cross-plugin grant, not a typo — and it resolves at
						// runtime (oleks/claudecode-linter#13).
						const fromDependency =
							declaredPlugin !== pluginName && dependencies.has(declaredPlugin);
						if (pluginName && declaredPlugin !== pluginName && !fromDependency) {
							push(
								diag(
									config,
									filePath,
									"agent-md/mcp-tools-resolve",
									"error",
									`Tool "${t}" references plugin "${declaredPlugin}", but this plugin is named "${pluginName}" and does not declare "${declaredPlugin}" in plugin.json "dependencies".`,
								),
							);
						}
						// The server behind a dependency's tool is declared in THAT
						// plugin's .mcp.json, not ours, so our list says nothing
						// about it.
						if (
							pluginRoot &&
							!fromDependency &&
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
				const toolProblem = toolNameProblem(t);
				if (toolProblem) {
					push(
						diag(
							config,
							filePath,
							"agent-md/known-tools",
							"warning",
							`${toolProblem} (in tools: field). Known built-ins: ${[...TOOLS].sort().join(", ")}.`,
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
