import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { monitorsJsonLinter } from "../../src/linters/monitors-json.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const DEFAULT_CONFIG: LinterConfig = { rules: {} };

function lint(path: string) {
	const content = readFileSync(path, "utf-8");
	return monitorsJsonLinter.lint(path, content, DEFAULT_CONFIG);
}

describe("monitors-json linter", () => {
	it("passes for a valid monitors.json array", () => {
		const diags = lint(resolve(FIXTURES, "valid-monitors/valid-monitors.json"));
		const errors = diags.filter((d) => d.severity === "error");
		expect(errors).toHaveLength(0);
	});

	it("rejects a non-array payload", () => {
		const diags = lint(resolve(FIXTURES, "invalid/monitors-json/not-array.json"));
		expect(
			diags.some((d) => d.rule === "monitors-json/valid-json"),
		).toBe(true);
	});

	it("reports invalid JSON", () => {
		const diags = monitorsJsonLinter.lint(
			"test.json",
			"not json",
			DEFAULT_CONFIG,
		);
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("monitors-json/valid-json");
	});

	it("flags missing required fields on a monitor entry", () => {
		const diags = lint(
			resolve(FIXTURES, "invalid/monitors-json/missing-required.json"),
		);
		const schema = diags.filter((d) => d.rule === "monitors-json/schema-valid");
		expect(schema.length).toBeGreaterThan(0);
		expect(schema.some((d) => d.message.includes("command"))).toBe(true);
		expect(schema.some((d) => d.message.includes("description"))).toBe(true);
	});

	it("flags unknown fields like skip/throttle (strictObject)", () => {
		const diags = lint(
			resolve(FIXTURES, "invalid/monitors-json/unknown-field.json"),
		);
		const schema = diags.filter((d) => d.rule === "monitors-json/schema-valid");
		expect(schema.some((d) => d.message.includes("skip"))).toBe(true);
		expect(schema.some((d) => d.message.includes("throttle"))).toBe(true);
	});

	it("flags duplicate monitor names (matches Claude Code refine check)", () => {
		const diags = lint(
			resolve(FIXTURES, "invalid/monitors-json/duplicate-name.json"),
		);
		const dups = diags.filter((d) => d.rule === "monitors-json/unique-names");
		expect(dups).toHaveLength(1);
		expect(dups[0].message).toMatch(/duplicated/);
	});

	it("respects disabling unique-names via config", () => {
		const config: LinterConfig = {
			rules: { "monitors-json/unique-names": false },
		};
		const content = readFileSync(
			resolve(FIXTURES, "invalid/monitors-json/duplicate-name.json"),
			"utf-8",
		);
		const diags = monitorsJsonLinter.lint("test.json", content, config);
		expect(diags.some((d) => d.rule === "monitors-json/unique-names")).toBe(
			false,
		);
	});
});
