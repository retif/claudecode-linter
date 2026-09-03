import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	checkDeps,
	loadAllManifests,
	loadManifest,
	type Mappings,
} from "../../scripts/check-deps.js";
import {
	MANIFEST_FILES,
	fetchManifestBody,
	manifestUrl,
	parseManifestBody,
	parseRefArg,
	sha256,
} from "../../scripts/fetch-module-replacements.js";

const REPO_ROOT = resolve(import.meta.dirname!, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-deps.ts");

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ccl-check-deps-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Write a complete, valid snapshot whose `preferred.json` lists `mods`. */
function writeSnapshot(dir: string, mods: string[] = ["some-unused-module"]) {
	mkdirSync(dir, { recursive: true });
	for (const file of MANIFEST_FILES) {
		const mappings: Record<string, unknown> = {};
		const names = file === "preferred.json" ? mods : ["placeholder-module"];
		for (const name of names) {
			mappings[name] = { moduleName: name, replacements: ["something-else"] };
		}
		writeFileSync(join(dir, file), JSON.stringify({ mappings }));
	}
}

/** Run the real CLI against a fixture snapshot directory. */
function runCli(snapshotDir: string): { status: number; output: string } {
	try {
		const out = execFileSync("npx", ["tsx", SCRIPT], {
			cwd: REPO_ROOT,
			env: { ...process.env, CHECK_DEPS_SNAPSHOT_DIR: snapshotDir },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, output: out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			status: err.status ?? -1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

/**
 * A stand-in `fetch` that answers with a fixed status/body, or rejects.
 *
 * The old `check-deps.ts` logged a non-OK response and `continue`d, so these
 * are exactly the cases that used to make the gate pass having compared
 * nothing.
 */
function stubFetch(
	opts: { ok?: boolean; status?: number; body?: string; reject?: Error },
): typeof fetch {
	return (async () => {
		if (opts.reject) throw opts.reject;
		return {
			ok: opts.ok ?? true,
			status: opts.status ?? 200,
			statusText: opts.status === 404 ? "Not Found" : "OK",
			text: async () => opts.body ?? "{}",
		} as Response;
	}) as unknown as typeof fetch;
}

describe("fetch failure fails the gate closed", () => {
	it("throws on a non-OK response instead of skipping the manifest", async () => {
		await expect(
			fetchManifestBody("https://example.invalid/preferred.json", stubFetch({
				ok: false,
				status: 404,
			})),
		).rejects.toThrow(/HTTP 404/);
	});

	it("throws on a 5xx response", async () => {
		await expect(
			fetchManifestBody("https://example.invalid/native.json", stubFetch({
				ok: false,
				status: 503,
			})),
		).rejects.toThrow(/HTTP 503/);
	});

	it("propagates a network-level rejection", async () => {
		await expect(
			fetchManifestBody("https://example.invalid/native.json", stubFetch({
				reject: new TypeError("fetch failed"),
			})),
		).rejects.toThrow(/fetch failed/);
	});

	it("returns the body on success", async () => {
		await expect(
			fetchManifestBody(
				"https://example.invalid/native.json",
				stubFetch({ body: '{"mappings":{"a":{}}}' }),
			),
		).resolves.toBe('{"mappings":{"a":{}}}');
	});
});

describe("parseManifestBody rejects unusable content", () => {
	it("rejects invalid JSON", () => {
		expect(() => parseManifestBody("{ not json", "x.json")).toThrow(
			/not valid JSON/,
		);
	});

	it("rejects a non-object body", () => {
		expect(() => parseManifestBody("[]", "x.json")).toThrow(/not a JSON object/);
		expect(() => parseManifestBody("null", "x.json")).toThrow(
			/not a JSON object/,
		);
	});

	it("rejects a body with no mappings key", () => {
		expect(() => parseManifestBody('{"replacements":[]}', "x.json")).toThrow(
			/no `mappings` object/,
		);
	});

	it("rejects mappings that is an array", () => {
		expect(() => parseManifestBody('{"mappings":[]}', "x.json")).toThrow(
			/no `mappings` object/,
		);
	});

	it("rejects an EMPTY mappings object — it would match nothing and pass", () => {
		expect(() => parseManifestBody('{"mappings":{}}', "x.json")).toThrow(
			/empty `mappings`/,
		);
	});

	it("accepts a well-formed manifest", () => {
		const parsed = parseManifestBody(
			'{"mappings":{"lodash.merge":{"replacements":["defu"]}}}',
			"x.json",
		);
		expect(Object.keys(parsed.mappings)).toEqual(["lodash.merge"]);
	});
});

describe("loadManifest / loadAllManifests fail closed", () => {
	it("throws when the vendored file is missing", () => {
		expect(() => loadManifest(tmp, "preferred.json")).toThrow(
			/Cannot read vendored manifest/,
		);
	});

	it("names the refresh command in the missing-file error", () => {
		expect(() => loadManifest(tmp, "preferred.json")).toThrow(
			/fetch-module-replacements/,
		);
	});

	it("throws when the vendored file is corrupt", () => {
		writeFileSync(join(tmp, "preferred.json"), "{ truncated");
		expect(() => loadManifest(tmp, "preferred.json")).toThrow(
			/not valid JSON/,
		);
	});

	it("throws when one of several manifests is missing", () => {
		writeSnapshot(tmp);
		rmSync(join(tmp, "micro-utilities.json"));
		expect(() => loadAllManifests(tmp)).toThrow(/Cannot read vendored manifest/);
	});

	it("refuses an empty manifest list rather than comparing nothing", () => {
		expect(() => loadAllManifests(tmp, [])).toThrow(/compares nothing/);
	});

	it("loads a complete snapshot", () => {
		writeSnapshot(tmp);
		const loaded = loadAllManifests(tmp);
		expect(loaded.map((m) => m.file)).toEqual([...MANIFEST_FILES]);
	});
});

describe("checkDeps comparison", () => {
	const manifests = (mappings: Mappings) => [
		{ file: "preferred.json", mappings },
	];

	it("reports a production dependency as an error", () => {
		const r = checkDeps(
			["semver"],
			[],
			manifests({ semver: { replacements: ["verkit"] } }),
		);
		expect(r.prodFound).toBe(1);
		expect(r.devFound).toBe(0);
		expect(r.findings[0]).toMatchObject({ dep: "semver", dev: false });
		expect(r.findings[0].hint).toContain("verkit");
	});

	it("reports a dev dependency as a warning only", () => {
		const r = checkDeps([], ["acorn"], manifests({ acorn: {} }));
		expect(r.prodFound).toBe(0);
		expect(r.devFound).toBe(1);
		expect(r.findings[0]).toMatchObject({ dep: "acorn", dev: true });
		expect(r.findings[0].hint).toContain("can be removed");
	});

	it("finds nothing when no dependency is listed", () => {
		const r = checkDeps(["picocolors"], ["vitest"], manifests({ other: {} }));
		expect(r).toMatchObject({ prodFound: 0, devFound: 0, findings: [] });
	});

	it("does not match inherited Object properties", () => {
		// `dep in mappings` would match "constructor"/"toString" on a plain
		// object literal; Object.hasOwn must not.
		const r = checkDeps(["constructor", "toString"], [], manifests({}));
		expect(r.prodFound).toBe(0);
	});
});

describe("check-deps CLI exits non-zero when the snapshot is unusable", () => {
	it("fails when the snapshot directory is empty", () => {
		const r = runCli(tmp);
		expect(r.status).toBe(1);
		expect(r.output).toMatch(/Cannot read vendored manifest/);
	});

	it("fails when a manifest is corrupt", () => {
		writeSnapshot(tmp);
		writeFileSync(join(tmp, "native.json"), "{ truncated");
		const r = runCli(tmp);
		expect(r.status).toBe(1);
		expect(r.output).toMatch(/not valid JSON/);
	});

	it("fails when a manifest has empty mappings", () => {
		writeSnapshot(tmp);
		writeFileSync(join(tmp, "native.json"), '{"mappings":{}}');
		const r = runCli(tmp);
		expect(r.status).toBe(1);
		expect(r.output).toMatch(/empty `mappings`/);
	});

	it("fails when a real production dependency is listed", () => {
		writeSnapshot(tmp, ["ajv"]);
		const r = runCli(tmp);
		expect(r.status).toBe(1);
		expect(r.output).toMatch(/ERROR ajv/);
	});

	it("passes on a clean snapshot", () => {
		writeSnapshot(tmp);
		const r = runCli(tmp);
		expect(r.status).toBe(0);
		expect(r.output).toMatch(/No replaceable dependencies found/);
	});

	it("passes on the committed snapshot — no network involved", () => {
		const r = runCli(join(REPO_ROOT, "contracts", "module-replacements"));
		expect(r.status).toBe(0);
	});
});

describe("snapshot provenance helpers", () => {
	it("builds a raw.githubusercontent URL for a ref", () => {
		expect(manifestUrl("abc123", "native.json")).toBe(
			"https://raw.githubusercontent.com/es-tooling/module-replacements/abc123/manifests/native.json",
		);
	});

	it("defaults --ref to main and reads an explicit one", () => {
		expect(parseRefArg([])).toBe("main");
		expect(parseRefArg(["--ref", "deadbeef"])).toBe("deadbeef");
	});

	it("rejects a --ref with no value", () => {
		expect(() => parseRefArg(["--ref"])).toThrow(/requires a value/);
		expect(() => parseRefArg(["--ref", "--other"])).toThrow(/requires a value/);
	});

	it("hashes a body deterministically", async () => {
		await expect(sha256("abc")).resolves.toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});
