import { describe, it, expect } from "vitest";
import {
	assertBundleUsable,
	assertParseCoverage,
	assertResolvedVersion,
	extractBunEmbeddedModules,
} from "../../scripts/extract-contracts.js";

const VERSION = "9.9.9";

/**
 * A stand-in for one embedded Claude Code module: the licence header, the
 * version banner, and enough `userFacingName` accessors and filler to clear the
 * corpus floor.
 */
function fakeModule(tools: string[], padTo = 0): string {
	const defs = tools
		.map((t) => `var ${t}Tool={userFacingName(){return"${t}"}};`)
		.join("");
	const head = `// (c) Anthropic PBC.\n// Version: ${VERSION}\nexport var x=1;${defs}`;
	if (head.length >= padTo) return head;
	// Pad with a syntactically valid, parseable tail.
	return head + `var pad="${"p".repeat(padTo - head.length)}";`;
}

const TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "ListAgents"];

/** Build a Bun-style binary: NUL-delimited text runs with binary noise around. */
function fakeBinary(modules: string[], opts: { bunShim?: boolean } = {}): Buffer {
	const parts: Buffer[] = [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00])];
	if (opts.bunShim) {
		// The 2.1.259 trap: a small bun-cjs module sitting far BEFORE the real
		// bundle, which the old marker-walk-back strategy would select.
		parts.push(
			Buffer.from(
				`// @bun @bytecode @bun-cjs\n(function(exports){var shim=1;})\n`,
			),
			Buffer.from([0x00]),
			Buffer.from([0xff, 0xfe, 0xfd, 0x00]),
		);
	}
	for (const m of modules) {
		parts.push(Buffer.from(m, "utf8"), Buffer.from([0x00]));
	}
	parts.push(Buffer.from([0xff, 0x00, 0xfe]));
	return Buffer.concat(parts);
}

describe("assertResolvedVersion", () => {
	it("accepts the version it asked for", () => {
		expect(() => assertResolvedVersion("2.1.259", "2.1.259")).not.toThrow();
	});

	it("accepts anything when no version was requested", () => {
		expect(() => assertResolvedVersion("2.1.197", undefined)).not.toThrow();
	});

	// The exact desync that froze the registry: the release job resolved 2.1.259
	// while npm pack served 2.1.197, and nothing compared the two.
	it("refuses a tarball that is not the requested release", () => {
		expect(() => assertResolvedVersion("2.1.197", "2.1.259")).toThrow(
			/Version mismatch.*2\.1\.259.*2\.1\.197/s,
		);
	});
});

describe("assertBundleUsable", () => {
	it("accepts a corpus that carries the banner and the tool definitions", () => {
		const modules = [fakeModule(TOOLS, 2_500_000)];
		expect(() => assertBundleUsable(modules, VERSION)).not.toThrow();
	});

	it("refuses an empty extraction", () => {
		expect(() => assertBundleUsable([], VERSION)).toThrow(/no modules/);
	});

	// The bootstrap shim is 411 KB; the floor is what stops it being accepted.
	it("refuses a corpus below the size floor", () => {
		const modules = [fakeModule(TOOLS, 411_031)];
		expect(() => assertBundleUsable(modules, VERSION)).toThrow(
			/below the 2000000-byte floor/,
		);
	});

	it("refuses a corpus belonging to a different release", () => {
		const modules = [fakeModule(TOOLS, 2_500_000)];
		expect(() => assertBundleUsable(modules, "1.2.3")).toThrow(
			/carries no "\/\/ Version: 1\.2\.3" banner/,
		);
	});

	// The load-bearing case: big enough, right version, but the tool registry is
	// simply not in the slice. A guard that only checked size would pass this.
	it("refuses a large, correctly-versioned corpus with no tool definitions", () => {
		const modules = [fakeModule([], 2_500_000)];
		expect(() => assertBundleUsable(modules, VERSION)).toThrow(
			/does not contain the tool registry/,
		);
	});

	it("refuses a corpus with too few tool definitions", () => {
		const modules = [fakeModule(["Bash", "Read"], 2_500_000)];
		expect(() => assertBundleUsable(modules, VERSION)).toThrow(
			/yields 2 userFacingName tool definitions/,
		);
	});
});

describe("assertParseCoverage", () => {
	it("tolerates a small unparseable fragment", () => {
		const modules = ["x".repeat(1_000_000), "y".repeat(1_500)];
		expect(() => assertParseCoverage(modules, [1_500])).not.toThrow();
	});

	it("refuses when most of the bundle failed to parse", () => {
		const modules = ["x".repeat(1_000_000), "y".repeat(1_000_000)];
		expect(() => assertParseCoverage(modules, [1_000_000])).toThrow(
			/Only 50\.0% of the bundle parsed/,
		);
	});

	it("refuses an empty corpus", () => {
		expect(() => assertParseCoverage([], [])).toThrow(/empty corpus/);
	});
});

describe("extractBunEmbeddedModules", () => {
	it("recovers every banner-carrying module from a code-split binary", () => {
		const mods = [
			fakeModule(["Bash", "Read", "Edit"], 900_000),
			fakeModule(["Write", "Glob"], 900_000),
			fakeModule(["Grep", "ListAgents"], 900_000),
		];
		const recovered = extractBunEmbeddedModules(fakeBinary(mods), VERSION);
		expect(recovered).toHaveLength(3);
		expect(recovered.join("\n")).toContain("ListAgents");
	});

	// The 2.1.259 shape: a bun-cjs shim far from the bundle. The old strategy
	// picked the shim; the banner-run strategy must ignore it.
	it("ignores a bun-cjs shim that precedes the real bundle", () => {
		const mods = [fakeModule(TOOLS, 2_500_000)];
		const recovered = extractBunEmbeddedModules(
			fakeBinary(mods, { bunShim: true }),
			VERSION,
		);
		expect(recovered.join("\n")).not.toContain("var shim=1");
		expect(recovered.join("\n")).toContain("ListAgents");
	});

	it("throws a diagnostic naming every failed strategy when nothing matches", () => {
		const junk = Buffer.concat([
			Buffer.from([0x00, 0xff]),
			Buffer.from("no bundle here at all"),
			Buffer.from([0x00]),
		]);
		expect(() => extractBunEmbeddedModules(junk, VERSION)).toThrow(
			/Every strategy failed/,
		);
	});

	// Regression for the exact defect: a binary whose only bun-cjs marker opens a
	// short shim, with the real bundle elsewhere. Selecting the shim yields
	// 411 KB of valid JS and no tools — which must be refused, not returned.
	it("refuses rather than returning a shim-sized slice", () => {
		const shimOnly = Buffer.concat([
			Buffer.from(`// @bun @bytecode @bun-cjs\nvar shim=1;\n`),
			Buffer.from([0x00]),
			Buffer.from(`// Version: ${VERSION}\nvar tiny=1;`),
			Buffer.from([0x00]),
		]);
		expect(() => extractBunEmbeddedModules(shimOnly, VERSION)).toThrow(
			/Every strategy failed/,
		);
	});
});
