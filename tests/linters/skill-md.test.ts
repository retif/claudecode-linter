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

	it("reports a cross-artifact frontmatter key as info, ignores unknown-everywhere keys", () => {
		const diags = lintFile(
			resolve(FIXTURES, "invalid/skill-md/unknown-frontmatter.md"),
		);
		const unknowns = diags.filter(
			(d) => d.rule === "skill-md/no-unknown-frontmatter",
		);
		// `color` is an agent key → one info; `xyzzy` is valid nowhere → silent.
		expect(unknowns).toHaveLength(1);
		expect(unknowns[0].severity).toBe("info");
		expect(unknowns[0].message).toContain("color");
		expect(unknowns[0].message).toContain("agent");
	});

	it("stays silent on a made-up frontmatter key", () => {
		const diags = lint(
			"---\nname: test\ndescription: Use this skill when testing.\nxyzzy: 1\n---\n\n## H\n\n" +
				"body ".repeat(200),
		);
		expect(
			diags.some((d) => d.rule === "skill-md/no-unknown-frontmatter"),
		).toBe(false);
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

	// oleks/claudecode-linter#12 — the fleet-wide ROUTING TRIGGERS sentinels are
	// structural: codegen rewrites exactly the span between them and skips files
	// that lack them. Since this linter only checks CHANGED files, flagging them
	// left 5+ plugins permanently unpushable the moment anyone touched their
	// SKILL.md, for a violation already on main.
	it("does not report HTML comments in a description", () => {
		const diags = lint(
			'---\nname: test\ndescription: Use when testing. Trigger on <!-- BEGIN ROUTING TRIGGERS -->"run the tests", "lint this"<!-- END ROUTING TRIGGERS -->.\n---\n\n# Test',
		);
		expect(
			diags.some((d) => d.rule === "skill-md/description-no-angle-brackets"),
		).toBe(false);
	});

	it("still reports real markup alongside an HTML comment", () => {
		const diags = lint(
			"---\nname: test\ndescription: Use when testing <html> output. <!-- a comment -->\n---\n\n# Test",
		);
		expect(
			diags.some((d) => d.rule === "skill-md/description-no-angle-brackets"),
		).toBe(true);
	});

	it("still reports an unterminated HTML comment", () => {
		const diags = lint(
			"---\nname: test\ndescription: Use when testing. <!-- BEGIN ROUTING TRIGGERS\n---\n\n# Test",
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

	// ── model-valid ───────────────────────────────────────────
	it("does not warn on a valid model alias or claude-* id", () => {
		for (const m of ["opus", "claude-sonnet-4-6-20250514"]) {
			const diags = skillMdLinter.lint(
				"SKILL.md",
				`---\nname: my-skill\ndescription: Use when X\nmodel: ${m}\n---\n\n## Body`,
				CONFIG,
			);
			expect(diags.some((d) => d.rule === "skill-md/model-valid")).toBe(false);
		}
	});

	it("warns on an unknown model value", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\nmodel: gpt-4\n---\n\n## Body",
			CONFIG,
		);
		const d = diags.filter((x) => x.rule === "skill-md/model-valid");
		expect(d).toHaveLength(1);
		expect(d[0].message).toContain("gpt-4");
	});

	it("does not warn on model-valid when model absent", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/model-valid")).toBe(false);
	});

	// ── effort-valid ──────────────────────────────────────────
	it("does not warn on a valid effort (named or integer)", () => {
		for (const e of ["high", "2"]) {
			const diags = skillMdLinter.lint(
				"SKILL.md",
				`---\nname: my-skill\ndescription: Use when X\neffort: ${e}\n---\n\n## Body`,
				CONFIG,
			);
			expect(diags.some((d) => d.rule === "skill-md/effort-valid")).toBe(false);
		}
	});

	it("warns on an invalid effort value", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\neffort: turbo\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/effort-valid")).toBe(true);
	});

	it("does not warn on effort-valid when effort absent", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/effort-valid")).toBe(false);
	});

	// ── allowed-tools-valid ───────────────────────────────────
	it("does not warn on valid tools or mcp__ patterns in allowed-tools", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\nallowed-tools:\n  - Bash\n  - Read\n  - mcp__gitea__list_my_repos\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/allowed-tools-valid")).toBe(
			false,
		);
	});

	it("warns on an unknown tool in allowed-tools", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\nallowed-tools:\n  - Bashh\n---\n\n## Body",
			CONFIG,
		);
		const d = diags.filter((x) => x.rule === "skill-md/allowed-tools-valid");
		expect(d).toHaveLength(1);
		expect(d[0].message).toContain("Bashh");
	});

	it("does not warn on allowed-tools-valid when absent", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/allowed-tools-valid")).toBe(
			false,
		);
	});

	// ── frontmatter-field-type ────────────────────────────────
	it("does not warn on real boolean disable-model-invocation / user-invocable", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/frontmatter-field-type")).toBe(
			false,
		);
	});

	it("warns when a boolean field is given a string value", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			'---\nname: my-skill\ndescription: Use when X\ndisable-model-invocation: "true"\n---\n\n## Body',
			CONFIG,
		);
		const d = diags.filter((x) => x.rule === "skill-md/frontmatter-field-type");
		expect(d).toHaveLength(1);
		expect(d[0].message).toContain("disable-model-invocation");
	});

	it("does not warn on frontmatter-field-type when both fields absent", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/frontmatter-field-type")).toBe(
			false,
		);
	});
});

// ───────────── auto-extracted JSON Schema rule (schema-valid) ─────────────

describe("skill-md — schema-valid (auto-extracted JSON Schema)", () => {
	it("does not flag valid skill frontmatter", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when the user asks to do X\ncontext: inline\nallowed-tools: [Read, Write]\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/schema-valid")).toBe(false);
	});

	it("flags an out-of-enum value on a known field", () => {
		// `context` is z.enum(["inline","fork"]).nullable() in Claude Code.
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\ncontext: sideways\n---\n\n## Body",
			CONFIG,
		);
		const d = diags.find((x) => x.rule === "skill-md/schema-valid");
		expect(d).toBeDefined();
		expect(d?.severity).toBe("error");
		expect(d?.message).toContain("context");
	});

	it("flags a structurally-wrong field type", () => {
		// `allowed-tools` must be a string or string array, never an object.
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\nallowed-tools:\n  foo: bar\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/schema-valid")).toBe(true);
	});

	it("flags a malformed `name` field (previously-hollow, now typed)", () => {
		// `name` is `LW()` — z.union([string,number,boolean,null]). Before the
		// LW/z36 walker fix this field was a bare `{}` placeholder and a mapping
		// value slipped through; it must now be rejected.
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname:\n  nested: map\ndescription: Use when X\n---\n\n## Body",
			CONFIG,
		);
		const d = diags.find((x) => x.rule === "skill-md/schema-valid");
		expect(d).toBeDefined();
		expect(d?.message).toContain("name");
	});

	it("flags a malformed `description` field (previously-hollow, now typed)", () => {
		// `description` is `LW()` too — a YAML list is not a string/scalar.
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription:\n  - a\n  - b\n---\n\n## Body",
			CONFIG,
		);
		const d = diags.find((x) => x.rule === "skill-md/schema-valid");
		expect(d).toBeDefined();
		expect(d?.message).toContain("description");
	});

	it("still accepts a scalar `name`/`model` (LW union permits string)", () => {
		// The LW union is permissive — a plain string name/model must not be
		// flagged. Guards against resolving z36 too strictly.
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\nmodel: opus\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/schema-valid")).toBe(false);
	});

	it("does not flag unknown frontmatter keys (schema is permissive)", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\ntotallyUnknownKey: 7\n---\n\n## Body",
			CONFIG,
		);
		expect(diags.some((d) => d.rule === "skill-md/schema-valid")).toBe(false);
	});

	it("is silenced when the rule is disabled", () => {
		const diags = skillMdLinter.lint(
			"SKILL.md",
			"---\nname: my-skill\ndescription: Use when X\ncontext: sideways\n---\n\n## Body",
			{ rules: { "skill-md/schema-valid": false } },
		);
		expect(diags.some((d) => d.rule === "skill-md/schema-valid")).toBe(false);
	});
});
