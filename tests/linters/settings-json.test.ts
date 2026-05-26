import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsJsonLinter } from "../../src/linters/settings-json.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lint(content: string) {
	return settingsJsonLinter.lint("test.json", content, CONFIG);
}

function lintFile(path: string) {
	return settingsJsonLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("settings-json linter", () => {
	it("passes for valid settings", () => {
		const diags = lintFile(
			resolve(FIXTURES, "valid-plugin/.claude/settings.local.json"),
		);
		const errors = diags.filter((d) => d.severity === "error");
		expect(errors).toHaveLength(0);
	});

	it("reports invalid JSON", () => {
		const diags = lint("not json");
		expect(diags.some((d) => d.rule === "settings-json/valid-json")).toBe(true);
	});

	it("reports unknown top-level fields", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/settings-json/bad-env.json"),
		);
		expect(
			diags.some((d) => d.rule === "settings-json/no-unknown-fields"),
		).toBe(true);
	});

	it("reports non-string env values", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/settings-json/bad-env.json"),
		);
		expect(
			diags.some((d) => d.rule === "settings-json/env-string-values"),
		).toBe(true);
	});

	it("reports unknown tools in allow list", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/settings-json/bad-permissions.json"),
		);
		expect(
			diags.some((d) => d.rule === "settings-json/allow-known-tools"),
		).toBe(true);
	});

	it("reports non-string entries in allow list", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/settings-json/bad-permissions.json"),
		);
		expect(diags.some((d) => d.rule === "settings-json/allow-array")).toBe(
			true,
		);
	});

	it("reports plugin keys missing @ format", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/settings-json/bad-plugins.json"),
		);
		expect(diags.some((d) => d.rule === "settings-json/plugins-format")).toBe(
			true,
		);
	});

	it("reports non-boolean plugin values", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/settings-json/bad-plugins.json"),
		);
		expect(diags.some((d) => d.rule === "settings-json/plugins-boolean")).toBe(
			true,
		);
	});

	it("accepts scoped tool patterns", () => {
		const diags = lint(
			JSON.stringify({
				permissions: {
					allow: ["Bash(npm test:*)", "WebFetch(domain:github.com)"],
				},
			}),
		);
		const toolWarns = diags.filter(
			(d) => d.rule === "settings-json/allow-known-tools",
		);
		expect(toolWarns).toHaveLength(0);
	});

	it("validates skipDangerousModePermissionPrompt is boolean", () => {
		const diags = lint(
			JSON.stringify({ skipDangerousModePermissionPrompt: "yes" }),
		);
		expect(
			diags.some((d) => d.rule === "settings-json/skip-prompt-boolean"),
		).toBe(true);
	});

	it("accepts settings.json at project level (gitea#4)", () => {
		// .claude/settings.json is projectSettings — committed/shared,
		// distinct from .claude/settings.local.json (localSettings).
		const diags = settingsJsonLinter.lint(
			"settings.json",
			JSON.stringify({ permissions: {} }),
			CONFIG,
			"project",
		);
		expect(diags.some((d) => d.rule === "settings-json/scope-file-name")).toBe(
			false,
		);
	});

	it("allows settings.json at user level", () => {
		const diags = settingsJsonLinter.lint(
			"settings.json",
			JSON.stringify({ permissions: {} }),
			CONFIG,
			"user",
		);
		expect(diags.some((d) => d.rule === "settings-json/scope-file-name")).toBe(
			false,
		);
	});

	it("warns only on genuinely user-only fields in project settings (gitea#2)", () => {
		// apiKeyHelper is user-only — should warn at project scope.
		const userOnly = settingsJsonLinter.lint(
			"settings.local.json",
			JSON.stringify({ apiKeyHelper: "/path/to/helper" }),
			CONFIG,
			"project",
		);
		expect(userOnly.some((d) => d.rule === "settings-json/scope-field")).toBe(true);

		// enableAllProjectMcpServers is project-scoped (Claude Code writes it to
		// localSettings itself) — must NOT warn at project scope.
		const projectField = settingsJsonLinter.lint(
			"settings.local.json",
			JSON.stringify({ enableAllProjectMcpServers: false }),
			CONFIG,
			"project",
		);
		expect(projectField.some((d) => d.rule === "settings-json/scope-field")).toBe(false);
	});

	it("allows permissions in project settings.local.json", () => {
		const diags = settingsJsonLinter.lint(
			"settings.local.json",
			JSON.stringify({ permissions: { allow: ["Bash"] } }),
			CONFIG,
			"project",
		);
		expect(diags.some((d) => d.rule === "settings-json/scope-field")).toBe(
			false,
		);
	});

	describe("disable-project-mcpjson-shadow", () => {
		function makePluginTree(opts: {
			mcpServers?: Record<string, unknown>;
			settings?: Record<string, unknown>;
			settingsLocal?: Record<string, unknown>;
		}): { settingsPath: string; cleanup: () => void } {
			const root = mkdtempSync(join(tmpdir(), "ccl-shadow-"));
			mkdirSync(join(root, ".claude-plugin"));
			mkdirSync(join(root, ".claude"));
			writeFileSync(join(root, ".claude-plugin", "plugin.json"),
				JSON.stringify({ name: "p" }));
			if (opts.mcpServers !== undefined) {
				writeFileSync(join(root, ".mcp.json"),
					JSON.stringify({ mcpServers: opts.mcpServers }));
			}
			const settingsPath = join(root, ".claude", "settings.json");
			writeFileSync(settingsPath, JSON.stringify(opts.settings ?? {}));
			if (opts.settingsLocal !== undefined) {
				writeFileSync(join(root, ".claude", "settings.local.json"),
					JSON.stringify(opts.settingsLocal));
			}
			return { settingsPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
		}

		it("warns when .mcp.json server is not in disabledMcpjsonServers", () => {
			const t = makePluginTree({
				mcpServers: { "my-mcp": { command: "x" } },
				settings: {},
			});
			try {
				const diags = lintFile(t.settingsPath);
				const d = diags.find((d) => d.rule === "settings-json/disable-project-mcpjson-shadow");
				expect(d).toBeDefined();
				expect(d?.message).toContain("my-mcp");
			} finally { t.cleanup(); }
		});

		it("does not warn when server name is in disabledMcpjsonServers", () => {
			const t = makePluginTree({
				mcpServers: { "my-mcp": { command: "x" } },
				settings: { disabledMcpjsonServers: ["my-mcp"] },
			});
			try {
				const diags = lintFile(t.settingsPath);
				expect(diags.some((d) => d.rule === "settings-json/disable-project-mcpjson-shadow")).toBe(false);
			} finally { t.cleanup(); }
		});

		it("accepts disable in sibling settings.local.json", () => {
			const t = makePluginTree({
				mcpServers: { "my-mcp": { command: "x" } },
				settings: {},
				settingsLocal: { disabledMcpjsonServers: ["my-mcp"] },
			});
			try {
				const diags = lintFile(t.settingsPath);
				expect(diags.some((d) => d.rule === "settings-json/disable-project-mcpjson-shadow")).toBe(false);
			} finally { t.cleanup(); }
		});

		it("does not fire outside a plugin tree (no .claude-plugin/plugin.json)", () => {
			const root = mkdtempSync(join(tmpdir(), "ccl-shadow-"));
			mkdirSync(join(root, ".claude"));
			const settingsPath = join(root, ".claude", "settings.json");
			writeFileSync(settingsPath, JSON.stringify({}));
			writeFileSync(join(root, ".mcp.json"),
				JSON.stringify({ mcpServers: { "x": { command: "y" } } }));
			try {
				const diags = lintFile(settingsPath);
				expect(diags.some((d) => d.rule === "settings-json/disable-project-mcpjson-shadow")).toBe(false);
			} finally { rmSync(root, { recursive: true, force: true }); }
		});

		it("does not fire when .mcp.json is absent", () => {
			const t = makePluginTree({ settings: {} });
			try {
				const diags = lintFile(t.settingsPath);
				expect(diags.some((d) => d.rule === "settings-json/disable-project-mcpjson-shadow")).toBe(false);
			} finally { t.cleanup(); }
		});
	});

	it("accepts mcp__ tool patterns in allow list", () => {
		const diags = lint(
			JSON.stringify({
				permissions: { allow: ["mcp__my-server"] },
			}),
		);
		expect(
			diags.some((d) => d.rule === "settings-json/allow-known-tools"),
		).toBe(false);
	});
});
