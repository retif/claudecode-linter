import { describe, it, expect } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeBlockedReason } from "../../src/utils/safe-write.js";

describe("writeBlockedReason", () => {
	it("returns null for a normal in-tree file", () => {
		const dir = mkdtempSync(join(tmpdir(), "safe-write-test-"));
		try {
			const file = join(dir, "plugin.json");
			writeFileSync(file, "{}");
			expect(writeBlockedReason(file, dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("returns null for an in-tree file in a nested subdirectory", () => {
		const dir = mkdtempSync(join(tmpdir(), "safe-write-test-"));
		try {
			const nested = join(dir, "skills", "deploy");
			mkdirSync(nested, { recursive: true });
			const file = join(nested, "SKILL.md");
			writeFileSync(file, "x");
			expect(writeBlockedReason(file, dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("refuses a path that is a symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "safe-write-test-"));
		try {
			const target = join(dir, "real.json");
			writeFileSync(target, "{}");
			const link = join(dir, "SKILL.md");
			symlinkSync(target, link);
			expect(writeBlockedReason(link, dir)).toBe("path is a symlink");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("refuses a path whose realpath escapes the target directory", () => {
		// A symlink inside rootDir points at a file in a sibling directory,
		// so realpathSync(escaping) resolves outside rootDir.
		const base = mkdtempSync(join(tmpdir(), "safe-write-test-"));
		try {
			const rootDir = join(base, "root");
			const outsideDir = join(base, "outside");
			mkdirSync(rootDir, { recursive: true });
			mkdirSync(outsideDir, { recursive: true });
			const outsideFile = join(outsideDir, "secret");
			writeFileSync(outsideFile, "secret");
			const escaping = join(rootDir, "artifact.json");
			symlinkSync(outsideFile, escaping);
			// The symlink check fires first here; either refusal reason is
			// acceptable -- the point is the write is blocked.
			expect(writeBlockedReason(escaping, rootDir)).not.toBeNull();
		} finally {
			rmSync(base, { recursive: true });
		}
	});

	it("refuses a non-symlink whose realpath lies outside the tree", () => {
		const base = mkdtempSync(join(tmpdir(), "safe-write-test-"));
		try {
			const rootDir = join(base, "root");
			mkdirSync(rootDir, { recursive: true });
			const outsideFile = join(base, "outside.json");
			writeFileSync(outsideFile, "{}");
			expect(writeBlockedReason(outsideFile, rootDir)).toBe(
				"path resolves outside the target directory",
			);
		} finally {
			rmSync(base, { recursive: true });
		}
	});

	it("fails closed for a non-existent path", () => {
		const dir = mkdtempSync(join(tmpdir(), "safe-write-test-"));
		try {
			expect(writeBlockedReason(join(dir, "nope.json"), dir)).not.toBeNull();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
