import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lspJsonLinter } from "../../src/linters/lsp-json.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const DEFAULT_CONFIG: LinterConfig = { rules: {} };

function lint(path: string) {
	const content = readFileSync(path, "utf-8");
	return lspJsonLinter.lint(path, content, DEFAULT_CONFIG);
}

describe("lsp-json linter", () => {
	it("passes for a valid .lsp.json (flat record of server-name → config)", () => {
		const diags = lint(resolve(FIXTURES, "valid-lsp/valid.lsp.json"));
		const errors = diags.filter((d) => d.severity === "error");
		expect(errors).toHaveLength(0);
	});

	it("reports invalid JSON", () => {
		const diags = lspJsonLinter.lint(
			"test.lsp.json",
			"{ bad json",
			DEFAULT_CONFIG,
		);
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("lsp-json/valid-json");
	});

	it("rejects a top-level non-object payload", () => {
		const diags = lspJsonLinter.lint(
			"test.lsp.json",
			JSON.stringify([{ command: "x" }]),
			DEFAULT_CONFIG,
		);
		expect(
			diags.some((d) => d.rule === "lsp-json/valid-json" && d.message.includes("map of server-name")),
		).toBe(true);
	});

	it("catches the lspServers wrapper bug with a friendly message", () => {
		const diags = lint(
			resolve(FIXTURES, "invalid/lsp-json/wrapper-lspServers.json"),
		);
		const wrapperDiag = diags.find(
			(d) => d.rule === "lsp-json/no-lsp-servers-wrapper",
		);
		expect(wrapperDiag).toBeDefined();
		expect(wrapperDiag?.severity).toBe("error");
		expect(wrapperDiag?.message).toMatch(/must not have a top-level "lspServers" key/);
		expect(wrapperDiag?.message).toMatch(/plugin\.json/);
	});

	it("flags missing required extensionToLanguage", () => {
		const diags = lint(
			resolve(FIXTURES, "invalid/lsp-json/missing-required.json"),
		);
		const schema = diags.filter((d) => d.rule === "lsp-json/schema-valid");
		expect(
			schema.some((d) => d.message.includes("extensionToLanguage")),
		).toBe(true);
	});

	it("flags unknown fields (filetypes, rootPatterns) via strictObject", () => {
		const diags = lint(resolve(FIXTURES, "invalid/lsp-json/unknown-fields.json"));
		const schema = diags.filter((d) => d.rule === "lsp-json/schema-valid");
		expect(schema.some((d) => d.message.includes("filetypes"))).toBe(true);
		expect(schema.some((d) => d.message.includes("rootPatterns"))).toBe(true);
	});

	it("flags invalid transport enum", () => {
		const diags = lint(resolve(FIXTURES, "invalid/lsp-json/wrong-transport.json"));
		const schema = diags.filter((d) => d.rule === "lsp-json/schema-valid");
		expect(schema.some((d) => d.message.includes("stdio") && d.message.includes("socket"))).toBe(true);
	});

	it("respects disabling no-lsp-servers-wrapper via config", () => {
		const config: LinterConfig = {
			rules: { "lsp-json/no-lsp-servers-wrapper": false },
		};
		const content = readFileSync(
			resolve(FIXTURES, "invalid/lsp-json/wrapper-lspServers.json"),
			"utf-8",
		);
		const diags = lspJsonLinter.lint("test.lsp.json", content, config);
		expect(
			diags.some((d) => d.rule === "lsp-json/no-lsp-servers-wrapper"),
		).toBe(false);
	});
});
