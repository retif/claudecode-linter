import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	assertDistFresh,
	findStaleDistReason,
} from "./helpers/dist-freshness.js";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "dist", "index.js");
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

// oleks/claudecode-linter#35: this is the only test file that runs the BUILT
// CLI, and `npm test` does not build. Without this guard the assertions below
// are checked against whatever `dist/` already holds, so editing the asserted
// string in `src/index.ts` and re-running still reports green.
//
// The guard lives here rather than in a `pretest` script so it holds for every
// way of invoking the suite — including `npx vitest run tests/resource-limits.test.ts`,
// which is what the issue's own reproduction used and what iterating on a test
// looks like. A `pretest` hook would not run at all in that case.
describe("dist/ freshness", () => {
	it("dist/ matches src/, so the CLI under test is the current build", () => {
		expect(findStaleDistReason(ROOT)).toBeNull();
	});
});

function runCli(args: string[]): { stdout: string; stderr: string } {
	// spawnSync never throws on a non-zero exit code, so both streams are
	// captured regardless of whether the lint run found errors.
	const r = spawnSync("node", [CLI, ...args], { encoding: "utf-8" });
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("MAX_ARTIFACT_BYTES cap", () => {
	// Refuse to report a verdict at all against a stale build: a passing
	// assertion here would otherwise be evidence about code that is no longer
	// in src/.
	beforeAll(() => assertDistFresh(ROOT));

	it("skips an artifact whose size exceeds the cap", () => {
		const dir = mkdtempSync(join(tmpdir(), "resource-limit-test-"));
		try {
			// A plugin.json larger than the 5 MiB cap. It is valid JSON, so
			// without the cap the linter would happily read and lint it.
			const pluginDir = join(dir, ".claude-plugin");
			mkdirSync(pluginDir, { recursive: true });
			const pluginJson = join(pluginDir, "plugin.json");
			const padding = " ".repeat(MAX_ARTIFACT_BYTES + 1024);
			writeFileSync(pluginJson, `{"name":"big-plugin","_pad":"${padding}"}`);
			expect(statSync(pluginJson).size).toBeGreaterThan(MAX_ARTIFACT_BYTES);

			const { stdout, stderr } = runCli([dir]);
			// The oversized artifact is skipped with a warning on stderr...
			expect(stderr).toMatch(/exceeds .* limit/);
			expect(stderr).toContain("plugin.json");
			// ...and never appears in the lint report on stdout.
			expect(stdout).not.toContain("big-plugin");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("lints a normally-sized artifact (cap does not trigger)", () => {
		const dir = mkdtempSync(join(tmpdir(), "resource-limit-test-"));
		try {
			const pluginDir = join(dir, ".claude-plugin");
			mkdirSync(pluginDir, { recursive: true });
			writeFileSync(
				join(pluginDir, "plugin.json"),
				'{"name":"small-plugin"}',
			);
			const { stderr } = runCli([dir]);
			expect(stderr).not.toMatch(/exceeds .* limit/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
