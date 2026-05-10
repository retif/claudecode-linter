import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

	it("reports settings.json at project level", () => {
		const diags = settingsJsonLinter.lint(
			"settings.json",
			JSON.stringify({ permissions: {} }),
			CONFIG,
			"project",
		);
		expect(diags.some((d) => d.rule === "settings-json/scope-file-name")).toBe(
			true,
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

	it("warns about user-level fields in project settings.local.json", () => {
		const diags = settingsJsonLinter.lint(
			"settings.local.json",
			JSON.stringify({ env: { FOO: "bar" } }),
			CONFIG,
			"project",
		);
		expect(diags.some((d) => d.rule === "settings-json/scope-field")).toBe(
			true,
		);
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
