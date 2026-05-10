import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { misplacedFileLinter } from "../../src/linters/misplaced-file.js";
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
