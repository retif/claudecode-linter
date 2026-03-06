import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { skillMdLinter } from "../../src/linters/skill-md.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lint(content: string) {
	return skillMdLinter.lint("test.md", content, CONFIG);
}

function lintFile(path: string) {
	return skillMdLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("skill-md linter", () => {
	it("passes for valid skill", () => {
		const diags = lintFile(
			resolve(FIXTURES, "valid-plugin/skills/example-skill/SKILL.md"),
		);
		const errors = diags.filter((d) => d.severity === "error");
		expect(errors).toHaveLength(0);
	});

	it("reports missing frontmatter", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/skill-md/no-frontmatter.md"),
		);
		expect(diags.some((d) => d.rule === "skill-md/valid-frontmatter")).toBe(
			true,
		);
	});

	it("reports missing name", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/skill-md/missing-name.md"),
		);
		expect(diags.some((d) => d.rule === "skill-md/name-required")).toBe(true);
	});

	it("reports non-kebab-case name", () => {
		const diags = lintFile(resolve(FIXTURES, "invalid/skill-md/bad-name.md"));
		expect(diags.some((d) => d.rule === "skill-md/name-kebab-case")).toBe(true);
	});

	it("reports missing trigger phrases", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/skill-md/no-triggers.md"),
		);
		expect(
			diags.some((d) => d.rule === "skill-md/description-trigger-phrases"),
		).toBe(true);
	});

	it("reports unknown frontmatter keys", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/skill-md/unknown-frontmatter.md"),
		);
		const unknowns = diags.filter(
			(d) => d.rule === "skill-md/no-unknown-frontmatter",
		);
		expect(unknowns).toHaveLength(2);
		expect(unknowns[0].message).toContain("foo");
	});

	it("reports short body", () => {
		const diags = lint(
			"---\nname: test\ndescription: This skill should be used when testing.\n---\n\n# Short\n\nToo short.",
		);
		expect(diags.some((d) => d.rule === "skill-md/body-word-count")).toBe(true);
	});

	it("reports description too long", () => {
		const longDesc = "x".repeat(1025);
		const diags = lint(
			`---\nname: test\ndescription: "${longDesc}"\n---\n\n# Test`,
		);
		expect(
			diags.some((d) => d.rule === "skill-md/description-max-length"),
		).toBe(true);
	});

	it("reports missing H2 headers", () => {
		const body = "word ".repeat(600);
		const diags = lint(
			`---\nname: test\ndescription: This skill should be used when testing.\n---\n\n${body}`,
		);
		expect(diags.some((d) => d.rule === "skill-md/body-has-headers")).toBe(
			true,
		);
	});

	it("reports description with angle brackets", () => {
		const diags = lint(
			"---\nname: test\ndescription: Use <html> tags for output.\n---\n\n# Test",
		);
		expect(
			diags.some((d) => d.rule === "skill-md/description-no-angle-brackets"),
		).toBe(true);
	});

	it("does not report description without angle brackets", () => {
		const diags = lint(
			"---\nname: test\ndescription: This skill should be used when testing output.\n---\n\n# Test",
		);
		expect(
			diags.some((d) => d.rule === "skill-md/description-no-angle-brackets"),
		).toBe(false);
	});

	it("respects disabled rules", () => {
		const config: LinterConfig = {
			rules: { "skill-md/description-trigger-phrases": false },
		};
		const diags = skillMdLinter.lint(
			"test.md",
			"---\nname: test\ndescription: A description without triggers.\n---\n\n# Test",
			config,
		);
		expect(
			diags.some((d) => d.rule === "skill-md/description-trigger-phrases"),
		).toBe(false);
	});
});
