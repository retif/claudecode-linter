import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { misplacedFileLinter } from "../../src/linters/misplaced-file.js";
import {
	CANONICAL_ARTIFACTS,
	isCanonicalLocation,
} from "../../src/canonical-paths.js";
import { discoverArtifacts } from "../../src/discovery.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

describe("misplaced-file linter", () => {
	it("flags hooks.json at .claude-plugin/hooks/ instead of plugin-root/hooks/", () => {
		const fixturePath = resolve(FIXTURES, "invalid/misplaced-file");
		const artifacts = discoverArtifacts(fixturePath);
		const misplaced = artifacts.filter(
			(a) => a.artifactType === "misplaced-file",
		);
		// the wrong-location hooks.json should be discovered
		expect(misplaced.length).toBeGreaterThanOrEqual(1);
		const wrongHooks = misplaced.find((m) =>
			m.filePath.includes(".claude-plugin/hooks/hooks.json"),
		);
		expect(wrongHooks).toBeDefined();
		// the linter emits the canonical-location diagnostic
		const diags = misplacedFileLinter.lint(wrongHooks!.filePath, "", CONFIG);
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("misplaced-file/canonical-location");
		expect(diags[0].severity).toBe("warning");
		expect(diags[0].message).toContain("hooks/hooks.json");
	});

	it("emits empty diagnostics for non-canonical basenames", () => {
		const diags = misplacedFileLinter.lint(
			"/some/path/random.json",
			"",
			CONFIG,
		);
		expect(diags).toEqual([]);
	});

	it("respects the disabled rule", () => {
		const disabled: LinterConfig = {
			rules: { "misplaced-file/canonical-location": false },
		};
		const diags = misplacedFileLinter.lint("/x/hooks.json", "", disabled);
		expect(diags).toEqual([]);
	});

	it("respects custom severity", () => {
		const cfg: LinterConfig = {
			rules: {
				"misplaced-file/canonical-location": {
					enabled: true,
					severity: "error",
				},
			},
		};
		const diags = misplacedFileLinter.lint("/x/hooks.json", "", cfg);
		expect(diags[0]?.severity).toBe("error");
	});
});

describe("project-local artifacts are not misplaced (issue #22)", () => {
	const skill = CANONICAL_ARTIFACTS.find((a) => a.basename === "SKILL.md")!;
	const settings = CANONICAL_ARTIFACTS.find(
		(a) => a.basename === "settings.json",
	)!;

	it("accepts .claude/skills/<name>/SKILL.md as a project-local skill", () => {
		expect(isCanonicalLocation(".claude/skills/helper/SKILL.md", skill)).toBe(
			true,
		);
	});

	it("still accepts the plugin skill location", () => {
		expect(isCanonicalLocation("skills/helper/SKILL.md", skill)).toBe(true);
	});

	it("still flags a genuinely misplaced plugin skill", () => {
		expect(isCanonicalLocation("SKILL.md", skill)).toBe(false);
		expect(isCanonicalLocation("docs/skills/helper/SKILL.md", skill)).toBe(
			false,
		);
		expect(isCanonicalLocation("skills/helper/nested/SKILL.md", skill)).toBe(
			false,
		);
	});

	it("does not blanket-exempt everything under .claude/", () => {
		// no <name> directory — Claude Code reads this as nothing
		expect(isCanonicalLocation(".claude/skills/SKILL.md", skill)).toBe(false);
		expect(isCanonicalLocation(".claude/skills/a/b/SKILL.md", skill)).toBe(
			false,
		);
		expect(isCanonicalLocation(".claude/SKILL.md", skill)).toBe(false);
	});

	it("accepts .claude/settings.json but not other .claude/ settings paths", () => {
		expect(isCanonicalLocation(".claude/settings.json", settings)).toBe(true);
		expect(isCanonicalLocation("settings.json", settings)).toBe(true);
		expect(isCanonicalLocation(".claude/nested/settings.json", settings)).toBe(
			false,
		);
		expect(isCanonicalLocation("config/settings.json", settings)).toBe(false);
	});

	it("reports no misplaced-file for a plugin carrying a project-local skill", () => {
		// valid-plugin is a plugin (.claude-plugin/) that also carries
		// .claude/skills/project-local-helper/SKILL.md
		const artifacts = discoverArtifacts(resolve(FIXTURES, "valid-plugin"));
		const misplaced = artifacts.filter(
			(a) => a.artifactType === "misplaced-file",
		);
		expect(misplaced.map((m) => m.filePath)).toEqual([]);
	});

	it("still discovers genuinely misplaced SKILL.md files", () => {
		const artifacts = discoverArtifacts(
			resolve(FIXTURES, "invalid/misplaced-file"),
		);
		const misplaced = artifacts
			.filter((a) => a.artifactType === "misplaced-file")
			.map((a) => a.filePath);
		expect(
			misplaced.some((f) => f.endsWith("docs/skills/deploy/SKILL.md")),
		).toBe(true);
		expect(misplaced.some((f) => f.endsWith(".claude/skills/SKILL.md"))).toBe(
			true,
		);
	});
});

describe("misplaced-file discovery", () => {
	it("does not scan outside plugin trees", () => {
		// Fixture has no `.claude-plugin/` so no misplaced-file scan
		// should run, even though there's a stray hooks.json present
		// in a subdirectory.
		const fixturePath = resolve(FIXTURES, "valid-plugin");
		const artifacts = discoverArtifacts(fixturePath);
		const misplaced = artifacts.filter(
			(a) => a.artifactType === "misplaced-file",
		);
		// valid-plugin has hooks.json at hooks/hooks.json (canonical)
		// and no other reserved-basename files at wrong paths, so
		// zero misplaced expected.
		expect(misplaced).toHaveLength(0);
	});
});
