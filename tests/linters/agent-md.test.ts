import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentMdLinter } from "../../src/linters/agent-md.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lintFile(path: string) {
	return agentMdLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("agent-md linter", () => {
	it("passes for valid agent", () => {
		const diags = lintFile(
			resolve(FIXTURES, "valid-plugin/agents/example-agent.md"),
		);
		const errors = diags.filter((d) => d.severity === "error");
		expect(errors).toHaveLength(0);
	});

	it("reports missing required fields", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/agent-md/missing-fields.md"),
		);
		const rules = diags.map((d) => d.rule);
		expect(rules).toContain("agent-md/description-required");
		expect(rules).toContain("agent-md/model-required");
		// gitea#3: color is .optional() @internal upstream; no longer required.
		expect(rules).not.toContain("agent-md/color-required");
	});

	it("reports invalid model", () => {
		const diags = lintFile(resolve(FIXTURES, "invalid/agent-md/bad-model.md"));
		expect(diags.some((d) => d.rule === "agent-md/model-valid")).toBe(true);
	});

	it("accepts versioned claude-* model IDs", () => {
		const content =
			"---\nname: versioned-model\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: claude-sonnet-4-6-20250514\ncolor: blue\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/model-valid")).toBe(false);
	});

	it("reports a description with no routing guidance", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/agent-md/no-examples.md"),
		);
		expect(
			diags.some((d) => d.rule === "agent-md/description-routing-guidance"),
		).toBe(true);
	});

	it("accepts a routing-triggers block as routing guidance", () => {
		const content =
			'---\nname: routed-agent\ndescription: Cluster ops agent. Trigger on <!-- BEGIN ROUTING TRIGGERS -->"deploy", "is it broken"<!-- END ROUTING TRIGGERS -->.\nmodel: sonnet\ncolor: blue\n---\n\nYou are a test agent.';
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.some((d) => d.rule === "agent-md/description-routing-guidance"),
		).toBe(false);
	});

	it("accepts <example> blocks as routing guidance", () => {
		const content =
			"---\nname: ex-agent\ndescription: |\n  A cluster ops agent.\n  <example>user: deploy this\nassistant: delegating</example>\nmodel: sonnet\ncolor: blue\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.some((d) => d.rule === "agent-md/description-routing-guidance"),
		).toBe(false);
	});

	it("accepts trigger prose as routing guidance", () => {
		const content =
			"---\nname: prose-agent\ndescription: Use this agent for cluster diagnostics when the user reports an outage.\nmodel: sonnet\ncolor: blue\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.some((d) => d.rule === "agent-md/description-routing-guidance"),
		).toBe(false);
	});

	it("reports empty system prompt", () => {
		const diags = lintFile(resolve(FIXTURES, "invalid/agent-md/no-prompt.md"));
		expect(diags.some((d) => d.rule === "agent-md/system-prompt-present")).toBe(
			true,
		);
	});

	it("reports short system prompt", () => {
		const content =
			"---\nname: short-prompt\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\n---\n\nHi.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/system-prompt-length")).toBe(
			true,
		);
	});

	it("reports missing second person in prompt", () => {
		const content =
			"---\nname: no-second-person\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\n---\n\nThis agent does things. It handles tasks and processes input correctly.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.some((d) => d.rule === "agent-md/system-prompt-second-person"),
		).toBe(true);
	});

	it("reports invalid color", () => {
		const content =
			"---\nname: bad-color\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: chartreuse\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/color-valid")).toBe(true);
	});

	it("reports a cross-artifact frontmatter key as info", () => {
		// `when_to_use` is skill frontmatter — misplaced on an agent.
		const content =
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\nwhen_to_use: stuff\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		const unknowns = diags.filter(
			(d) => d.rule === "agent-md/no-unknown-frontmatter",
		);
		expect(unknowns).toHaveLength(1);
		expect(unknowns[0].severity).toBe("info");
		expect(unknowns[0].message).toContain("when_to_use");
		expect(unknowns[0].message).toContain("skill");
	});

	it("stays silent on made-up frontmatter keys", () => {
		const content =
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ncustom-field: hello\nanother: world\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.filter((d) => d.rule === "agent-md/no-unknown-frontmatter"),
		).toHaveLength(0);
	});

	it("does not report known frontmatter fields as unknown", () => {
		const content =
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.filter((d) => d.rule === "agent-md/no-unknown-frontmatter"),
		).toHaveLength(0);
	});

	it("warns on unknown built-in tools", () => {
		const content =
			"---\nname: bad-tool\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: Bash, Read, Bashh\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		const known = diags.filter((d) => d.rule === "agent-md/known-tools");
		expect(known).toHaveLength(1);
		expect(known[0].message).toContain('"Bashh"');
	});

	it("does not warn on valid built-in tools", () => {
		const content =
			"---\nname: ok-tools\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: Bash, Read, Edit, Glob, Grep, WebFetch\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.filter((d) => d.rule === "agent-md/known-tools")).toHaveLength(
			0,
		);
	});

	it("recognizes Monitor and other late-added built-in tools", () => {
		const content =
			"---\nname: ok-tools\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: Monitor, PushNotification, CronCreate, CronDelete, CronList, RemoteTrigger\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.filter((d) => d.rule === "agent-md/known-tools")).toHaveLength(
			0,
		);
	});

	it("flags bare mcp__server__tool form inside a plugin", async () => {
		// Plugin fixture with .mcp.json declaring server "gitea" + plugin name "test-plugin".
		// Build a temp plugin tree on the fly.
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "test-plugin", version: "1.0.0" }),
		);
		writeFileSync(
			resolve(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { gitea: { command: "/x" } } }),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: Bash, mcp__gitea__list_my_repos\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		const errs = diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve");
		expect(errs).toHaveLength(1);
		expect(errs[0].message).toContain("bare");
		expect(errs[0].message).toContain("mcp__plugin_test-plugin_gitea__");
	});

	it("flags MCP tool referencing wrong plugin name", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "real-plugin", version: "1.0.0" }),
		);
		writeFileSync(
			resolve(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { gitea: { command: "/x" } } }),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: mcp__plugin_wrong-plugin_gitea__list_my_repos\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		const errs = diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve");
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.some((e) => e.message.includes('"wrong-plugin"'))).toBe(true);
	});

	// oleks/claudecode-linter#13: a plugin may grant its agents the tools of a
	// plugin it DEPENDS on, and they resolve at runtime. Without reading
	// plugin.json "dependencies" the rule could not tell that from a typo.
	it("accepts an MCP tool from a plugin declared in dependencies", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({
				name: "anxious",
				version: "1.0.0",
				dependencies: [{ name: "cluster", version: ">=0.34.2" }],
			}),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: mcp__plugin_cluster_gitea-tools__issue_read\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		expect(
			diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve"),
		).toHaveLength(0);
	});

	it("accepts a bare-string dependency entry too", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "anxious", version: "1.0.0", dependencies: ["cluster"] }),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: mcp__plugin_cluster_gitea-tools__issue_read\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		expect(
			diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve"),
		).toHaveLength(0);
	});

	// The dependency's servers live in ITS .mcp.json, so ours says nothing about
	// them — the server check must not fire on a cross-plugin tool either.
	it("does not check our .mcp.json for a dependency's server", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({
				name: "anxious",
				version: "1.0.0",
				dependencies: [{ name: "cluster", version: ">=0.34.2" }],
			}),
		);
		writeFileSync(
			resolve(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { "own-server": { command: "/x" } } }),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: mcp__plugin_cluster_gitea-tools__issue_read\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		expect(
			diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve"),
		).toHaveLength(0);
	});

	// The negative control: an UNdeclared plugin is still an error, so the fix
	// narrows the rule rather than defeating it.
	it("still flags a plugin that is not declared in dependencies", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({
				name: "anxious",
				version: "1.0.0",
				dependencies: [{ name: "cluster", version: ">=0.34.2" }],
			}),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: mcp__plugin_clustr_gitea-tools__issue_read\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		const errs = diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve");
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.some((e) => e.message.includes('"clustr"'))).toBe(true);
	});

	it("flags MCP tool referencing undeclared server", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "test-plugin", version: "1.0.0" }),
		);
		writeFileSync(
			resolve(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { gitea: { command: "/x" } } }),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: mcp__plugin_test-plugin_grafana__query\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		const errs = diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve");
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.some((e) => e.message.includes('"grafana"'))).toBe(true);
	});

	it("warns on Glob/Grep declared in a plugin agent (upstream bug #52055)", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "test-plugin", version: "1.0.0" }),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: Bash, Read, Glob, Grep\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		const warns = diags.filter(
			(d) => d.rule === "agent-md/plugin-subagent-blocked-tools",
		);
		expect(warns).toHaveLength(2);
		expect(warns.some((w) => w.message.includes('"Glob"'))).toBe(true);
		expect(warns.some((w) => w.message.includes('"Grep"'))).toBe(true);
		expect(warns[0].message).toContain("52055");
	});

	it("does not warn on Glob/Grep outside a plugin", () => {
		const content =
			"---\nname: ok-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: Bash, Read, Glob, Grep\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint(
			"/tmp/some-non-plugin/test.md",
			content,
			CONFIG,
		);
		expect(
			diags.filter((d) => d.rule === "agent-md/plugin-subagent-blocked-tools"),
		).toHaveLength(0);
	});

	// ── permissionMode-valid ──────────────────────────────────
	it("warns on an invalid permissionMode value", () => {
		const content =
			"---\nname: pm-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\npermissionMode: yolo\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		const d = diags.filter((x) => x.rule === "agent-md/permission-mode-valid");
		expect(d).toHaveLength(1);
		expect(d[0].severity).toBe("warning");
		expect(d[0].message).toContain("yolo");
	});

	it("does not warn on a valid permissionMode value", () => {
		const content =
			"---\nname: pm-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\npermissionMode: acceptEdits\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.some((d) => d.rule === "agent-md/permission-mode-valid"),
		).toBe(false);
	});

	it("does not warn on permission-mode-valid when permissionMode absent", () => {
		const content =
			"---\nname: pm-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(
			diags.some((d) => d.rule === "agent-md/permission-mode-valid"),
		).toBe(false);
	});

	// ── effort-valid ──────────────────────────────────────────
	it("does not warn on a valid named effort level", () => {
		const content =
			"---\nname: ef-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\neffort: high\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/effort-valid")).toBe(false);
	});

	it("does not warn on an integer effort value", () => {
		const content =
			"---\nname: ef-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\neffort: 3\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/effort-valid")).toBe(false);
	});

	it("warns on an unknown effort string", () => {
		const content =
			"---\nname: ef-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\neffort: xhigh\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		const d = diags.filter((x) => x.rule === "agent-md/effort-valid");
		expect(d).toHaveLength(1);
		expect(d[0].message).toContain("xhigh");
	});

	it("warns on a non-integer effort number", () => {
		const content =
			"---\nname: ef-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\neffort: 2.5\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/effort-valid")).toBe(true);
	});

	it("does not warn on effort-valid when effort absent", () => {
		const content =
			"---\nname: ef-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/effort-valid")).toBe(false);
	});

	// ── max-turns-valid ───────────────────────────────────────
	it("does not warn on a positive integer maxTurns", () => {
		const content =
			"---\nname: mt-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\nmaxTurns: 12\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/max-turns-valid")).toBe(false);
	});

	it("warns on a non-integer / zero / string maxTurns", () => {
		for (const val of ["2.5", "0", '"10"', "-3"]) {
			const content = `---\nname: mt-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\nmaxTurns: ${val}\n---\n\nYou are a test agent.`;
			const diags = agentMdLinter.lint("test.md", content, CONFIG);
			expect(diags.some((d) => d.rule === "agent-md/max-turns-valid")).toBe(
				true,
			);
		}
	});

	it("does not warn on max-turns-valid when maxTurns absent", () => {
		const content =
			"---\nname: mt-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\n---\n\nYou are a test agent.";
		const diags = agentMdLinter.lint("test.md", content, CONFIG);
		expect(diags.some((d) => d.rule === "agent-md/max-turns-valid")).toBe(false);
	});

	it("accepts properly-namespaced plugin MCP tools", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const root = mkdtempSync(resolve(tmpdir(), "linter-test-"));
		mkdirSync(resolve(root, ".claude-plugin"));
		mkdirSync(resolve(root, "agents"));
		writeFileSync(
			resolve(root, ".claude-plugin/plugin.json"),
			JSON.stringify({ name: "test-plugin", version: "1.0.0" }),
		);
		writeFileSync(
			resolve(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { gitea: { command: "/x" } } }),
		);
		const agentPath = resolve(root, "agents/test.md");
		writeFileSync(
			agentPath,
			"---\nname: test-agent\ndescription: |\n  <example>\n  user: test\n  </example>\nmodel: sonnet\ncolor: blue\ntools: Bash, mcp__plugin_test-plugin_gitea__list_my_repos\n---\n\nYou are a test agent.",
		);
		const diags = agentMdLinter.lint(
			agentPath,
			readFileSync(agentPath, "utf-8"),
			CONFIG,
		);
		expect(
			diags.filter((d) => d.rule === "agent-md/mcp-tools-resolve"),
		).toHaveLength(0);
	});
});

// ───────────── auto-extracted JSON Schema rule (schema-valid) ─────────────

describe("agent-md — schema-valid (auto-extracted JSON Schema)", () => {
	it("does not flag valid agent frontmatter", () => {
		const diags = agentMdLinter.lint(
			"agent.md",
			"---\nname: my-agent\ndescription: Use this for X\nmodel: sonnet\ncolor: blue\ntools: Bash, Read\n---\n\nYou are an agent.",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "agent-md/schema-valid")).toBe(false);
	});

	it("flags a structurally-wrong field type", () => {
		// `tools` must be a string or string array, never an object.
		const diags = agentMdLinter.lint(
			"agent.md",
			"---\nname: my-agent\ndescription: Use this for X\nmodel: sonnet\ncolor: blue\ntools:\n  a: b\n---\n\nYou are an agent.",
			CONFIG,
		);
		const d = diags.find((x) => x.rule === "agent-md/schema-valid");
		expect(d).toBeDefined();
		expect(d?.severity).toBe("error");
		expect(d?.message).toContain("tools");
	});

	it("flags a missing schema-required field", () => {
		// Claude Code's agent schema requires `name`.
		const diags = agentMdLinter.lint(
			"agent.md",
			"---\ndescription: Use this for X\nmodel: sonnet\ncolor: blue\n---\n\nYou are an agent.",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "agent-md/schema-valid")).toBe(true);
	});

	it("flags a malformed `description` field (previously-hollow, now typed)", () => {
		// `description` is `LW()` — z.union([string,number,boolean,null]). Before
		// the LW/z36 walker fix this resolved to a bare `{}` placeholder and any
		// shape passed; a YAML mapping value must now be rejected.
		const diags = agentMdLinter.lint(
			"agent.md",
			"---\nname: my-agent\ndescription:\n  nested: map\nmodel: sonnet\n---\n\nYou are an agent.",
			CONFIG,
		);
		const d = diags.find((x) => x.rule === "agent-md/schema-valid");
		expect(d).toBeDefined();
		expect(d?.message).toContain("description");
	});

	it("still accepts a scalar `effort` (LW union permits string and number)", () => {
		// `effort` is `LW()` — "low/medium/high/max, or an integer". Both a
		// string keyword and an integer must pass; the union must not be
		// resolved to anything stricter.
		for (const val of ["high", "3"]) {
			const diags = agentMdLinter.lint(
				"agent.md",
				`---\nname: my-agent\ndescription: Use this for X\neffort: ${val}\n---\n\nYou are an agent.`,
				CONFIG,
			);
			expect(
				diags.some((d) => d.rule === "agent-md/schema-valid"),
			).toBe(false);
		}
	});

	it("does not flag unknown frontmatter keys (schema is permissive)", () => {
		const diags = agentMdLinter.lint(
			"agent.md",
			"---\nname: my-agent\ndescription: Use this for X\nmodel: sonnet\ncolor: blue\ntotallyUnknownKey: 7\n---\n\nYou are an agent.",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "agent-md/schema-valid")).toBe(false);
	});

	it("is silenced when the rule is disabled", () => {
		const diags = agentMdLinter.lint(
			"agent.md",
			"---\nname: my-agent\ndescription: Use this for X\nmodel: sonnet\ncolor: blue\ntools:\n  a: b\n---\n\nYou are an agent.",
			{ rules: { "agent-md/schema-valid": false } },
		);
		expect(diags.some((d) => d.rule === "agent-md/schema-valid")).toBe(false);
	});
});
