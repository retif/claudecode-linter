import { describe, it, expect } from "vitest";
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

const CLI = resolve(import.meta.dirname, "..", "dist", "index.js");
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

function runCli(args: string[]): { stdout: string; stderr: string } {
	// spawnSync never throws on a non-zero exit code, so both streams are
	// captured regardless of whether the lint run found errors.
	const r = spawnSync("node", [CLI, ...args], { encoding: "utf-8" });
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("MAX_ARTIFACT_BYTES cap", () => {
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
