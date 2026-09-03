#!/usr/bin/env tsx
/**
 * Extracts artifact contracts from the latest @anthropic-ai/claude-code npm package.
 *
 * Parses the minified cli.js bundle using acorn AST analysis to find:
 * - Tool names (PascalCase identifiers used in permissions/allowed-tools)
 * - Hook event names (used in hooks.json)
 * - Agent colors and models (used in agent frontmatter)
 * - Plugin.json fields, skill frontmatter keys, MCP server fields, settings fields
 *
 * Output: contracts/claude-code-contracts.json
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import type * as AcornWalk from "acorn-walk";
import pc from "picocolors";

const require = createRequire(import.meta.url);
const walk = require("acorn-walk") as AcornWalk;

// ---------------------------------------------------------------------------
// 1. Download and extract cli.js
// ---------------------------------------------------------------------------

export interface CliSource {
	/** Every embedded JS module belonging to this Claude Code version. */
	modules: string[];
	/** All modules joined — the corpus the regex/anchor extractors scan. */
	source: string;
	version: string;
	sdkToolsDts: string | null;
}

function fetchCliSource(requestedVersion?: string): CliSource {
	const npmPkg = requestedVersion
		? `@anthropic-ai/claude-code@${requestedVersion}`
		: "@anthropic-ai/claude-code";
	const tmp = mkdtempSync(join(tmpdir(), "claude-code-"));
	try {
		execSync(`npm pack ${npmPkg} --pack-destination .`, {
			cwd: tmp,
			stdio: "pipe",
		});
		const tgz = execSync("ls *.tgz", { cwd: tmp, encoding: "utf8" }).trim();
		execSync(`tar xzf "${tgz}"`, { cwd: tmp, stdio: "pipe" });

		const pkg = JSON.parse(
			readFileSync(join(tmp, "package", "package.json"), "utf8"),
		);

		assertResolvedVersion(pkg.version, requestedVersion);

		let sdkToolsDts: string | null = null;
		try {
			sdkToolsDts = readFileSync(
				join(tmp, "package", "sdk-tools.d.ts"),
				"utf8",
			);
		} catch {
			// File may not exist in all versions
		}

		// Legacy layout (<= 2.1.112): package shipped cli.js directly.
		const legacyCli = join(tmp, "package", "cli.js");
		if (existsSync(legacyCli)) {
			const modules = [readFileSync(legacyCli, "utf8")];
			return {
				modules,
				source: joinModules(modules),
				version: pkg.version,
				sdkToolsDts,
			};
		}

		// New layout (>= 2.1.113): wrapper package + Bun-compiled native binary
		// shipped in a platform-specific optional dependency.
		const modules = fetchModulesFromNativeBinary(tmp, pkg.version);
		return {
			modules,
			source: joinModules(modules),
			version: pkg.version,
			sdkToolsDts,
		};
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Refuse a tarball that is not the release we asked for.
 *
 * The release workflow resolves the target version itself (`npm view`) and then
 * tags, bumps and publishes against it, while the extractor used to re-resolve
 * the `latest` dist-tag independently via `npm pack`. On 2026-09-03 those two
 * resolutions disagreed — `npm view` said 2.1.259, `npm pack` served 2.1.197 —
 * and because nothing compared them, the job succeeded, committed contracts
 * stamped `"version": "2.1.197"` with a fresh `extractedAt`, and tagged the
 * result v2.1.259. That is how the registry froze for ten-plus releases without
 * anything failing (oleks/claudecode-linter#28, oleks/claudecode-linter#30).
 *
 * The workflow now passes `--version`, and a mismatch is fatal: extracting the
 * wrong release under the right name is worse than not extracting at all.
 */
export function assertResolvedVersion(
	resolvedVersion: string,
	requestedVersion?: string,
): void {
	if (!requestedVersion) return;
	if (resolvedVersion === requestedVersion) return;
	throw new Error(
		`Version mismatch: asked npm for @anthropic-ai/claude-code@${requestedVersion}, ` +
			`got ${resolvedVersion}. Refusing to extract — the contracts would be ` +
			`stamped with a version they were not taken from.`,
	);
}

function joinModules(modules: string[]): string {
	return modules.join("\n");
}

function fetchModulesFromNativeBinary(tmp: string, version: string): string[] {
	const platformDir = join(tmp, "platform");
	mkdirSync(platformDir);
	const platformPkg = `@anthropic-ai/claude-code-linux-x64@${version}`;
	console.log(pc.cyan(`▸ Fetching ${platformPkg} for embedded bundle...`));
	execSync(`npm pack ${platformPkg} --pack-destination .`, {
		cwd: platformDir,
		stdio: "pipe",
	});
	const tgz = execSync("ls *.tgz", {
		cwd: platformDir,
		encoding: "utf8",
	}).trim();
	execSync(`tar xzf "${tgz}"`, { cwd: platformDir, stdio: "pipe" });

	const binary = readFileSync(join(platformDir, "package", "claude"));
	return extractBunEmbeddedModules(binary, version);
}

// ---------------------------------------------------------------------------
// 1b. Slicing the embedded JS out of the Bun binary
// ---------------------------------------------------------------------------

/** A corpus smaller than this cannot be the Claude Code bundle. */
const MIN_CORPUS_BYTES = 2_000_000;

/**
 * How many distinct `userFacingName` tool accessors the corpus must contain.
 *
 * This is the assertion that actually catches a bad slice. A wrong-offset or
 * truncated slice yields zero of them; only a corpus that really contains the
 * tool definitions clears the floor. Deliberately well below the ~23 a healthy
 * release harvests, so an upstream refactor shrinking the set is a warning
 * elsewhere rather than a false failure here.
 */
const MIN_TOOL_DEFINITIONS = 5;

/**
 * Recover the JS modules Bun embedded in the native `claude` executable.
 *
 * Bun stores each module as a run of text terminated by a NUL byte. Claude Code
 * prefixes every one of its own modules with a licence header ending in a
 * `// Version: X.Y.Z` banner, so the banner both selects the modules that
 * belong to this release and proves which release they came from.
 *
 * Two strategies, tried in order, each validated by `assertBundleUsable` before
 * it is accepted:
 *
 *  1. **Banner runs** — every NUL-delimited run containing the version banner.
 *     This is the layout of current releases, which ship a code-split bundle:
 *     2.1.259 embeds 1,635 modules totalling ~32.5 MB, the largest only 5.6 MB.
 *  2. **Legacy bun-cjs slice** — the single CJS module that older releases
 *     (<= ~2.1.197) put the whole bundle in, found by walking back from the
 *     banner to the `// @bun @bytecode @bun-cjs` marker.
 *
 * Strategy 2 alone was the previous implementation and it broke on 2.1.259:
 * that binary contains exactly one `// @bun @bytecode @bun-cjs` marker, at
 * offset 17,590,671, and it opens a 411,031-byte bootstrap shim — 160 MB before
 * the bundle at 177,517,618. The slice therefore held no tool definitions at
 * all, acorn hit the shim's trailing NULs 411,031 bytes in, and the run died
 * (oleks/claudecode-linter#28).
 */
export function extractBunEmbeddedModules(
	binary: Buffer,
	version: string,
): string[] {
	const failures: string[] = [];

	for (const strategy of [
		{ name: "version-banner runs", run: () => sliceBannerRuns(binary, version) },
		{ name: "legacy bun-cjs slice", run: () => sliceLegacyBunCjs(binary, version) },
	]) {
		let modules: string[];
		try {
			modules = strategy.run();
		} catch (err) {
			failures.push(`${strategy.name}: ${(err as Error).message}`);
			continue;
		}
		try {
			assertBundleUsable(modules, version);
		} catch (err) {
			failures.push(`${strategy.name}: ${(err as Error).message}`);
			continue;
		}
		console.log(
			pc.dim(
				`  Bundle recovered via ${strategy.name} ` +
					`(${modules.length} module(s), ${(joinModules(modules).length / 1e6).toFixed(1)}MB)`,
			),
		);
		return modules;
	}

	throw new Error(
		`Could not recover the Claude Code v${version} bundle from the native ` +
			`binary. Every strategy failed:\n  - ${failures.join("\n  - ")}\n` +
			`The binary layout has probably changed again; re-measure the marker ` +
			`offsets before adjusting the strategies.`,
	);
}

/**
 * Every NUL-delimited run that carries the `// Version: X.Y.Z` banner, in file
 * order and de-duplicated (a run may carry the banner more than once).
 */
function sliceBannerRuns(binary: Buffer, version: string): string[] {
	const banner = Buffer.from(`// Version: ${version}`);
	const seen = new Set<string>();
	const runs: Array<[number, number]> = [];

	for (let i = binary.indexOf(banner); i !== -1; i = binary.indexOf(banner, i + 1)) {
		const start = binary.lastIndexOf(0, i) + 1;
		const nextNul = binary.indexOf(0, i);
		const end = nextNul === -1 ? binary.length : nextNul;
		const key = `${start}:${end}`;
		if (seen.has(key)) continue;
		seen.add(key);
		runs.push([start, end]);
	}

	if (runs.length === 0) {
		throw new Error(`no NUL-delimited run carries "// Version: ${version}"`);
	}

	runs.sort((a, b) => a[0] - b[0]);
	return runs.map(([start, end]) => binary.subarray(start, end).toString("utf8"));
}

/**
 * The pre-code-splitting layout: one big CJS module opened by the
 * `// @bun @bytecode @bun-cjs` marker that precedes the version banner. Acorn's
 * first parse error marks the trailing NULs, so it doubles as the end offset.
 */
function sliceLegacyBunCjs(binary: Buffer, version: string): string[] {
	const versionIdx = binary.indexOf(Buffer.from(`// Version: ${version}`));
	if (versionIdx === -1) {
		throw new Error(`no "// Version: ${version}" banner in the binary`);
	}
	const bunMarker = Buffer.from("// @bun @bytecode @bun-cjs");
	const bundleStart = binary.lastIndexOf(bunMarker, versionIdx);
	if (bundleStart === -1) {
		throw new Error("no '// @bun @bytecode @bun-cjs' marker precedes the banner");
	}

	const MAX_SLICE = 60_000_000;
	const slice = binary
		.subarray(bundleStart, Math.min(bundleStart + MAX_SLICE, binary.length))
		.toString("utf8");

	try {
		acorn.parse(slice, { sourceType: "module", ecmaVersion: "latest" });
		return [slice];
	} catch (err: unknown) {
		const pos = (err as { pos?: number }).pos;
		if (typeof pos !== "number") throw err;
		return [slice.slice(0, pos)];
	}
}

/**
 * The regression guard: refuse a slice that does not actually contain the
 * bundle.
 *
 * This is the half of oleks/claudecode-linter#28 that matters. The extractor
 * must never emit a plausible-but-partial contracts file, because a shrunken
 * registry looks exactly like an upstream release that removed things, and the
 * downstream drift gate then reads the shortfall as legitimate. A guard that
 * only asked "did we get some text?" would reproduce the original defect, so
 * this asserts on the presence of the tool definitions themselves.
 */
/**
 * Refuse an extraction where acorn could not parse most of the corpus.
 *
 * Individual skips are expected — a banner-carrying run is not always a whole
 * module. But if a minifier or layout change makes most modules unparseable,
 * every AST-derived contract (tools, hook events, agent colours, all the
 * object-key censuses) silently collapses to whatever the previous file held,
 * which is precisely the quiet rot this issue is about. Measured on a healthy
 * 2.1.259 extraction: 1,634 of 1,635 modules parse, 99.995% of the bytes.
 */
export function assertParseCoverage(
	modules: string[],
	unparsedLengths: number[],
): void {
	const MIN_PARSED_BYTE_RATIO = 0.9;
	const total = modules.reduce((sum, m) => sum + m.length, 0);
	if (total === 0) throw new Error("empty corpus — nothing to parse");

	const skipped = unparsedLengths.reduce((sum, n) => sum + n, 0);
	const ratio = (total - skipped) / total;
	if (ratio < MIN_PARSED_BYTE_RATIO) {
		throw new Error(
			`Only ${(ratio * 100).toFixed(1)}% of the bundle parsed ` +
				`(${unparsedLengths.length}/${modules.length} modules skipped, ` +
				`${skipped} of ${total} bytes). Below the ` +
				`${(MIN_PARSED_BYTE_RATIO * 100).toFixed(0)}% floor — refusing to write ` +
				`contracts derived from a fraction of the bundle.`,
		);
	}
}

export function assertBundleUsable(modules: string[], version: string): void {
	if (modules.length === 0) {
		throw new Error("no modules recovered");
	}

	const source = joinModules(modules);
	if (source.length < MIN_CORPUS_BYTES) {
		throw new Error(
			`corpus is ${source.length} bytes, below the ${MIN_CORPUS_BYTES}-byte floor ` +
				`— this is a shim or a truncated slice, not the bundle`,
		);
	}

	if (!source.includes(`// Version: ${version}`)) {
		throw new Error(
			`corpus carries no "// Version: ${version}" banner — it may belong to a ` +
				`different release than the one being extracted`,
		);
	}

	const toolNames = extractUserFacingToolNames(source);
	if (toolNames.length < MIN_TOOL_DEFINITIONS) {
		throw new Error(
			`corpus yields ${toolNames.length} userFacingName tool definitions ` +
				`(${toolNames.join(", ") || "none"}), below the floor of ` +
				`${MIN_TOOL_DEFINITIONS} — the slice does not contain the tool registry`,
		);
	}
}

// ---------------------------------------------------------------------------
// 2. AST helpers
// ---------------------------------------------------------------------------

type StringSet = { values: string[]; pos: number };

function extractStringArrayElements(
	node: acorn.ArrayExpression,
): string[] | null {
	const strings: string[] = [];
	for (const el of node.elements) {
		if (
			!el ||
			el.type !== "Literal" ||
			typeof (el as acorn.Literal).value !== "string"
		)
			return null;
		strings.push((el as acorn.Literal).value as string);
	}
	return strings.length >= 2 ? strings : null;
}

function collectStringSets(ast: acorn.Program, offset = 0): StringSet[] {
	const results: StringSet[] = [];

	walk.simple(ast, {
		NewExpression(node: any) {
			if (
				node.callee.type === "Identifier" &&
				node.callee.name === "Set" &&
				node.arguments.length === 1 &&
				node.arguments[0].type === "ArrayExpression"
			) {
				const strings = extractStringArrayElements(node.arguments[0]);
				if (strings) results.push({ values: strings, pos: offset + node.start });
			}
		},
		ArrayExpression(node: any) {
			const strings = extractStringArrayElements(node);
			if (strings && strings.length >= 3) {
				results.push({ values: strings, pos: offset + node.start });
			}
		},
	});

	return results;
}

// ---------------------------------------------------------------------------
// 2b. Object key census
// ---------------------------------------------------------------------------

export type ObjectKeySet = { keys: string[]; pos: number };

export function collectObjectKeySets(
	ast: acorn.Program,
	offset = 0,
	seen = new Set<string>(),
): ObjectKeySet[] {
	const results: ObjectKeySet[] = [];

	walk.simple(ast, {
		ObjectExpression(node: any) {
			const keys: string[] = [];
			for (const prop of node.properties) {
				if (prop.type === "SpreadElement") continue;
				if (prop.computed) continue;
				if (prop.key.type === "Identifier") {
					keys.push(prop.key.name);
				} else if (
					prop.key.type === "Literal" &&
					typeof prop.key.value === "string"
				) {
					keys.push(prop.key.value);
				}
			}
			if (keys.length < 3 || keys.length > 150) return;

			const signature = [...keys].sort().join(",");
			if (seen.has(signature)) return;
			seen.add(signature);

			results.push({ keys, pos: offset + node.start });
		},
	});

	return results;
}

// ---------------------------------------------------------------------------
// 2c. Overlap-based classification
// ---------------------------------------------------------------------------

export function classifyByOverlap(
	sets: ObjectKeySet[],
	knownValues: string[],
): string[] {
	if (sets.length === 0 || knownValues.length === 0) return [];

	const knownSet = new Set(knownValues);
	const MIN_OVERLAP_FLOOR = 3;
	const MIN_SCORE = 0.3;

	let bestKeys: string[] = [];
	let bestScore = 0;
	let bestSizeDiff = Infinity;

	for (const s of sets) {
		const intersectionCount = s.keys.filter((k) => knownSet.has(k)).length;
		if (intersectionCount < MIN_OVERLAP_FLOOR) continue;

		const score =
			intersectionCount / Math.max(s.keys.length, knownValues.length);
		if (score < MIN_SCORE) continue;

		const sizeDiff = Math.abs(s.keys.length - knownValues.length);

		if (score > bestScore || (score === bestScore && sizeDiff < bestSizeDiff)) {
			bestScore = score;
			bestKeys = s.keys;
			bestSizeDiff = sizeDiff;
		}
	}

	return bestKeys;
}

// ---------------------------------------------------------------------------
// 3. Classification heuristics
// ---------------------------------------------------------------------------

const TOOL_ANCHORS = new Set([
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"Agent",
	"AskUserQuestion",
	"NotebookEdit",
	"TodoWrite",
]);

const EVENT_ANCHORS = new Set([
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SubagentStop",
	"SessionStart",
	"SessionEnd",
]);

const COLOR_ANCHORS = new Set([
	"blue",
	"cyan",
	"green",
	"yellow",
	"magenta",
	"red",
]);

function overlap(arr: string[], anchors: Set<string>): number {
	return arr.filter((s) => anchors.has(s)).length;
}

function isPascalCase(s: string): boolean {
	return /^[A-Z][a-zA-Z0-9]+$/.test(s);
}

interface ClassifiedSets {
	tools: string[][];
	hookEvents: string[][];
	agentColors: string[][];
}

function classifySets(sets: StringSet[]): ClassifiedSets {
	const result: ClassifiedSets = {
		tools: [],
		hookEvents: [],
		agentColors: [],
	};

	for (const s of sets) {
		const v = s.values;

		if (v.every(isPascalCase) && overlap(v, TOOL_ANCHORS) >= 2) {
			result.tools.push(v);
			continue;
		}

		if (overlap(v, EVENT_ANCHORS) >= 3 && v.length <= 30) {
			result.hookEvents.push(v);
			continue;
		}

		if (overlap(v, COLOR_ANCHORS) >= 3 && v.length <= 15) {
			result.agentColors.push(v);
			continue;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// 4. Schema extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the balanced-brace block starting at `braceStart` in `source`.
 * Returns the substring including the outermost { }.
 */
function extractBalancedBlock(
	source: string,
	braceStart: number,
	maxLen = 20000,
): string {
	let depth = 0;
	for (let i = braceStart; i < source.length && i < braceStart + maxLen; i++) {
		if (source[i] === "{") depth++;
		if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(braceStart, i + 1);
		}
	}
	return "";
}

/**
 * Extract top-level object keys from a Zod schema block like `{name:I.string(), author:cBA()}`.
 * Properly skips over string literals and nested braces/parens/brackets.
 */
export function extractTopLevelKeys(schema: string): string[] {
	const keys: string[] = [];
	let depth = 0;
	let pos = 1; // skip opening {
	let inString: string | null = null;

	while (pos < schema.length - 1) {
		const ch = schema[pos];

		// Track string boundaries
		if (inString) {
			if (ch === "\\") {
				pos += 2;
				continue;
			}
			if (ch === inString) inString = null;
			pos++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = ch;
			pos++;
			continue;
		}

		// Handle spread objects: ...{key: value} — enter without incrementing depth
		if (
			depth === 0 &&
			ch === "." &&
			schema.slice(pos, pos + 4).match(/^\.\.\.\{/)
		) {
			pos += 4; // skip ...{
			continue;
		}

		if (ch === "{" || ch === "(" || ch === "[") depth++;
		else if (ch === "}" || ch === ")" || ch === "]") {
			if (depth > 0) depth--;
			// depth 0 closing } from a spread — just skip it
		} else if (depth === 0) {
			const keyMatch = schema.slice(pos).match(/^(\$?\w+):/);
			if (keyMatch) {
				keys.push(keyMatch[1]);
				pos += keyMatch[0].length;
				continue;
			}
		}
		pos++;
	}
	return keys;
}

interface ValidationResult {
	failed: boolean;
	errors: string[];
	warnings: string[];
}

export function validateContracts(
	rawExtracted: Record<string, string[] | undefined>,
	previousContracts: Record<string, string[]>,
): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	for (const [field, prevValues] of Object.entries(previousContracts)) {
		if (!prevValues || prevValues.length === 0) continue;

		// Skip categories where extraction returned undefined (complete failure).
		// These will be filled by mergeWithPrevious — only gate on partial results.
		if (!(field in rawExtracted) || rawExtracted[field] === undefined) continue;

		const extractedSet = new Set(rawExtracted[field]!);
		const lost = prevValues.filter((v) => !extractedSet.has(v));
		const dropRate = lost.length / prevValues.length;

		if (dropRate > 0.5) {
			errors.push(
				`${field}: lost ${lost.length}/${prevValues.length} values (${(dropRate * 100).toFixed(0)}%): ${lost.join(", ")}`,
			);
		} else if (lost.length > 0) {
			warnings.push(
				`${field}: lost ${lost.length}/${prevValues.length} values (${(dropRate * 100).toFixed(0)}%): ${lost.join(", ")}`,
			);
		}
	}

	return { failed: errors.length > 0, errors, warnings };
}

const DTS_NAME_MAP: Record<string, string> = {
	FileRead: "Read",
	FileEdit: "Edit",
	FileWrite: "Write",
};

export function parseToolsDts(content: string): string[] {
	if (!content) return [];

	const tools = new Set<string>();
	const pattern = /export interface (\w+)Input\b/g;
	for (const m of content.matchAll(pattern)) {
		const raw = m[1];
		const mapped = DTS_NAME_MAP[raw] ?? raw;
		tools.add(mapped);
	}
	return [...tools].sort();
}

// ---------------------------------------------------------------------------
// 5. Specific extractors
// ---------------------------------------------------------------------------

function extractAgentModelEnum(source: string): string[] {
	const pattern =
		/I\.enum\(\[([^\]]+)\]\)\.optional\(\)\.describe\("Model to use for this agent/;
	const match = pattern.exec(source);
	if (!match) return [];
	return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Tool names as the `allowed-tools` / permission surface spells them.
 *
 * Two sources, unioned:
 *
 *  1. A structural harvest of each tool's `userFacingName()` accessor — the
 *     value Claude Code itself matches an `allowed-tools` entry against. This
 *     is what lets a tool the linter has never heard of be discovered on a
 *     sync; the hardcoded name list this function used to be could by
 *     construction only ever re-find the names already typed into it, which is
 *     why `ListAgents` stayed missing across every release after it shipped
 *     (oleks/claudecode-linter#21).
 *  2. The literal-anchor scan, kept as a floor so a minifier change that
 *     breaks the accessor patterns cannot empty the list.
 *
 * Names are shape-filtered to PascalCase: the same accessors also carry
 * internal lowercase identifiers (`autocompact`, `mcp`, `readMcpResource`)
 * that are not addressable as tools.
 */
const USER_FACING_NAME_PATTERNS: RegExp[] = [
	/userFacingName\(\)\s*\{\s*return\s*["']([A-Za-z][A-Za-z0-9]*)["']/g,
	/userFacingName:\s*\(\)\s*=>\s*["']([A-Za-z][A-Za-z0-9]*)["']/g,
	/userFacingName:\s*["']([A-Za-z][A-Za-z0-9]*)["']/g,
];

export function extractUserFacingToolNames(source: string): string[] {
	const names = new Set<string>();
	for (const pattern of USER_FACING_NAME_PATTERNS) {
		pattern.lastIndex = 0;
		for (const m of source.matchAll(pattern)) {
			if (isPascalCase(m[1])) names.add(m[1]);
		}
	}
	return [...names].sort();
}

function extractAllToolNames(source: string): string[] {
	const candidates = new Set<string>(extractUserFacingToolNames(source));

	// Floor: known tool name string literals.
	const toolLiteralPattern =
		/["'](Read|Write|Edit|Bash|Glob|Grep|WebFetch|WebSearch|Agent|AskUserQuestion|NotebookEdit|NotebookRead|TodoWrite|EnterPlanMode|ExitPlanMode|Skill|EnterWorktree|ExitWorktree|SendMessage|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskStop|TaskOutput|TeamCreate|TeamDelete|ToolSearch|LSP|Monitor|PushNotification|CronCreate|CronDelete|CronList|RemoteTrigger)["']/g;
	for (const m of source.matchAll(toolLiteralPattern)) {
		candidates.add(m[1]);
	}

	return [...candidates].sort();
}

function extractHookTypes(source: string): string[] {
	const pattern =
		/I\.literal\("(command|prompt|http|agent)"\)\.describe\("[^"]*hook type"\)/g;
	return [...source.matchAll(pattern)].map((m) => m[1]);
}

function extractPromptEvents(source: string): string[] {
	const pattern =
		/hookEventName:I\.literal\("(\w+)"\)[^}]*permissionDecision|hookEventName:I\.literal\("(\w+)"\)[^}]*additionalContext/g;
	const events = new Set<string>();
	for (const m of source.matchAll(pattern)) {
		events.add(m[1] || m[2]);
	}
	return [...events];
}

/**
 * Project-scoped settings sections and the allowed sub-keys of `permissions`
 * and `sandbox`.
 *
 * Anchored on the project-settings validator's per-section key map — a plain
 * `new Set([...])` literal that survives minification far better than the Zod
 * `.describe(...)` anchors used elsewhere in this file:
 *
 *   _={permissions:new Set([...]),sandbox:new Set([...]),hooks:new Set([...])}
 *
 * The three keys are exactly the sections Claude Code accepts in
 * project-level settings.local.json; the Sets are their allowed sub-keys.
 */
function extractSettingsSections(source: string): {
	projectFields: string[];
	permissionsFields: string[];
	sandboxFields: string[];
} {
	const re =
		/permissions:new Set\(\[([^\]]*)\]\),sandbox:new Set\(\[([^\]]*)\]\),hooks:new Set\(\[([^\]]*)\]\)/;
	const m = re.exec(source);
	if (!m) {
		return { projectFields: [], permissionsFields: [], sandboxFields: [] };
	}
	const strings = (group: string): string[] =>
		[...group.matchAll(/"([^"]+)"/g)].map((s) => s[1]);
	return {
		projectFields: ["permissions", "sandbox", "hooks"],
		permissionsFields: strings(m[1]),
		sandboxFields: strings(m[2]),
	};
}

function extractMcpServerFields(source: string): string[] {
	const fields = new Set<string>();

	// Extract from each transport type schema, skipping hook schemas
	const transports = ["stdio", "sse", "http"];

	for (const transport of transports) {
		const literal = `type:I.literal("${transport}")`;
		let searchIdx = 0;

		while (true) {
			const idx = source.indexOf(literal, searchIdx);
			if (idx === -1) break;
			searchIdx = idx + 1;

			const objStart = source.lastIndexOf("I.object({", idx);
			if (objStart === -1) continue;
			const braceStart = objStart + "I.object(".length;

			const block = extractBalancedBlock(source, braceStart);
			if (!block) continue;

			// Skip hook schemas (they contain "hook type" in their describes)
			if (block.includes("hook type")) continue;

			for (const k of extractTopLevelKeys(block)) fields.add(k);
			break; // use first non-hook match
		}
	}

	// `cwd` is not in the Zod schema but Claude Code passes it through to child_process.spawn.
	// Detect it from the runtime pass-through pattern: cwd:VAR.cwd
	if (/cwd:\w+\.cwd/.test(source)) {
		fields.add("cwd");
	}

	return [...fields];
}

function extractSkillFrontmatter(source: string): string[] {
	const fields = new Set<string>();

	const dotPattern = /\b\w+\.(name|description|version|model|when_to_use)\b/g;
	const bracketPattern =
		/\w+\["(allowed-tools|argument-hint|disable-model-invocation|user-invocable)"\]/g;

	const skillRegions: number[] = [];
	const skillAnchor = /\["allowed-tools"\]/g;
	for (const m of source.matchAll(skillAnchor)) {
		skillRegions.push(m.index!);
	}

	if (skillRegions.length === 0) return [];

	for (const regionStart of skillRegions) {
		const start = Math.max(0, regionStart - 2000);
		const end = Math.min(source.length, regionStart + 2000);
		const region = source.slice(start, end);

		for (const m of region.matchAll(dotPattern)) fields.add(m[1]);
		for (const m of region.matchAll(bracketPattern)) fields.add(m[1]);
	}

	return [...fields].sort();
}

// ---------------------------------------------------------------------------
// 6. Merge helpers
// ---------------------------------------------------------------------------

function mergeArrays(arrays: string[][]): string[] {
	const merged = new Set<string>();
	for (const arr of arrays) {
		for (const v of arr) merged.add(v);
	}
	return [...merged].sort();
}

function longestArray(arrays: string[][]): string[] {
	if (arrays.length === 0) return [];
	return arrays.reduce((a, b) => (a.length >= b.length ? a : b));
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

function main() {
	const versionIdx = process.argv.indexOf("--version");
	const requestedVersion =
		versionIdx !== -1 ? process.argv[versionIdx + 1] : undefined;

	// `--binary <path>` extracts from an already-downloaded platform binary
	// instead of fetching one. The bundle is a 216 MB native executable, so
	// reproducing an extraction problem — or checking that the guards fire —
	// should not require re-downloading it each time.
	const binaryIdx = process.argv.indexOf("--binary");
	const binaryPath = binaryIdx !== -1 ? process.argv[binaryIdx + 1] : undefined;

	let modules: string[];
	let source: string;
	let version: string;
	let sdkToolsDts: string | null;

	if (binaryPath) {
		if (!requestedVersion) {
			console.error(
				pc.red("✗ --binary requires --version (the binary carries no manifest)"),
			);
			process.exit(1);
		}
		console.log(
			pc.cyan(`▸ Reading local binary ${binaryPath} (v${requestedVersion})...`),
		);
		modules = extractBunEmbeddedModules(
			readFileSync(binaryPath),
			requestedVersion,
		);
		source = modules.join("\n");
		version = requestedVersion;
		sdkToolsDts = null;
	} else {
		const label = requestedVersion ? `v${requestedVersion}` : "latest";
		console.log(pc.cyan(`▸ Fetching @anthropic-ai/claude-code (${label})...`));
		({ modules, source, version, sdkToolsDts } =
			fetchCliSource(requestedVersion));
	}
	console.log(
		pc.cyan("▸ Parsing AST"),
		pc.dim(
			`(v${version}, ${modules.length} module(s), ${(source.length / 1e6).toFixed(1)}MB)`,
		),
	);

	// Current releases ship a code-split bundle — 1,600+ separate ESM modules
	// rather than one file — so each is parsed on its own and the results are
	// accumulated. Parsing the concatenation instead would fail immediately:
	// every module redeclares the same minified identifiers.
	const stringSets: StringSet[] = [];
	const objectKeySets: ObjectKeySet[] = [];
	const objectKeySeen = new Set<string>();
	const unparsed: number[] = [];
	let offset = 0;
	for (const mod of modules) {
		try {
			const ast = acorn.parse(mod, {
				sourceType: "module",
				ecmaVersion: "latest",
			}) as acorn.Program;
			stringSets.push(...collectStringSets(ast, offset));
			objectKeySets.push(...collectObjectKeySets(ast, offset, objectKeySeen));
		} catch {
			// A run that carries the banner is not guaranteed to be a whole module
			// — the first one in 2.1.259 is a 1.5 KB fragment of the licence
			// header. Skipping is fine; skipping *most* of them is not, which is
			// what the ratio check below catches.
			unparsed.push(mod.length);
		}
		offset += mod.length + 1;
	}

	assertParseCoverage(modules, unparsed);

	console.log(
		pc.cyan("▸ Extracting contracts..."),
		pc.dim(
			`(${stringSets.length} string sets, ${objectKeySets.length} object-key sets` +
				(unparsed.length > 0 ? `, ${unparsed.length} module(s) skipped` : "") +
				")",
		),
	);

	// --- String-set classification (tools, events, colors — already robust) ---
	const classified = classifySets(stringSets);
	const allTools = extractAllToolNames(source);

	// --- d.ts cross-validation for tools ---
	if (sdkToolsDts) {
		const dtsTools = parseToolsDts(sdkToolsDts);
		const censusTools = new Set(allTools);
		const missingFromCensus = dtsTools.filter((t) => !censusTools.has(t));
		if (missingFromCensus.length > 0) {
			console.log(
				pc.yellow(
					`  ⚠ Tools in sdk-tools.d.ts but not in bundle: ${missingFromCensus.join(", ")}`,
				),
			);
			// Add them — d.ts is authoritative for SDK tools
			for (const t of missingFromCensus) allTools.push(t);
			allTools.sort();
		}
	} else {
		console.log(
			pc.yellow(
				"  ⚠ sdk-tools.d.ts not found in package — skipping d.ts cross-validation",
			),
		);
	}

	// --- Object-key census classification (replaces fragile anchor extractors) ---
	const rootDir = join(import.meta.dirname!, "..");
	const outPath = join(rootDir, "contracts", "claude-code-contracts.json");

	// Load previous contracts for census classification + merge
	let prev: Record<string, string[]> = {};
	try {
		const existing = JSON.parse(readFileSync(outPath, "utf8"));
		prev = existing.contracts ?? {};
	} catch {
		// First run — no previous file
	}

	const pluginFields = classifyByOverlap(
		objectKeySets,
		prev["pluginJsonFields"] ?? [],
	);
	const agentFields = classifyByOverlap(
		objectKeySets,
		prev["agentFrontmatter"] ?? [],
	);
	const commandFields = classifyByOverlap(
		objectKeySets,
		prev["commandFrontmatter"] ?? [],
	);
	const mcpFieldsCensus = classifyByOverlap(
		objectKeySets,
		prev["mcpServerFields"] ?? [],
	);
	const mcpFieldsFallback = extractMcpServerFields(source);
	const mcpFields = [...new Set([...mcpFieldsCensus, ...mcpFieldsFallback])];
	const settingsUserFields = classifyByOverlap(
		objectKeySets,
		prev["settingsUserFields"] ?? [],
	);
	const skillFieldsCensus = classifyByOverlap(
		objectKeySets,
		prev["skillFrontmatter"] ?? [],
	);
	const skillFieldsFallback = extractSkillFrontmatter(source);
	const skillFields = [
		...new Set([...skillFieldsCensus, ...skillFieldsFallback]),
	].sort();

	// Small enum sets: union census + anchor fallback results
	const agentModelEnum = [
		...new Set([
			...classifyByOverlap(objectKeySets, prev["agentModels"] ?? []),
			...extractAgentModelEnum(source),
		]),
	];
	// hookTypes and promptEvents: small/subset categories where census matches
	// the same object as hookEvents. Use dedicated extractors only.
	const hookTypes = extractHookTypes(source);
	const promptEvents = extractPromptEvents(source);

	// settingsProjectFields + permissions/sandbox sub-keys: one stable anchor
	const settingsSections = extractSettingsSections(source);

	// --- Raw extracted contracts (before merge) ---
	const rawContracts: Record<string, string[] | undefined> = {
		tools:
			allTools.length > mergeArrays(classified.tools).length
				? allTools
				: mergeArrays(classified.tools),
		hookEvents: longestArray(classified.hookEvents).sort(),
		hookTypes: hookTypes.length > 0 ? hookTypes.sort() : undefined,
		promptEvents: promptEvents.length > 0 ? promptEvents.sort() : undefined,
		agentColors: (() => {
			// 2.1.259 stopped declaring the agent palette as a string array and
			// now keys an object by colour name
			// (`{red:"red_FOR_SUBAGENTS_ONLY",…}`, read back via `Object.keys`),
			// which the array/Set classifier cannot see at all. Union the
			// object-key census in so a representation change costs nothing;
			// without it the drift gate hard-fails at 100% loss.
			const colors = [
				...new Set([
					...longestArray(classified.agentColors),
					...classifyByOverlap(objectKeySets, prev["agentColors"] ?? []),
				]),
			];
			if (colors.includes("purple") && !colors.includes("magenta"))
				colors.push("magenta");
			if (colors.includes("magenta") && !colors.includes("purple"))
				colors.push("purple");
			return colors.sort();
		})(),
		agentModels: agentModelEnum.length > 0 ? agentModelEnum.sort() : undefined,
		pluginJsonFields: pluginFields.length > 0 ? pluginFields : undefined,
		agentFrontmatter: agentFields.length > 0 ? agentFields : undefined,
		commandFrontmatter: commandFields.length > 0 ? commandFields : undefined,
		mcpServerFields: mcpFields.length > 0 ? mcpFields : undefined,
		skillFrontmatter: skillFields.length > 0 ? skillFields : undefined,
		settingsUserFields:
			settingsUserFields.length > 0 ? settingsUserFields.sort() : undefined,
		settingsProjectFields:
			settingsSections.projectFields.length > 0
				? settingsSections.projectFields.sort()
				: undefined,
		permissionsFields:
			settingsSections.permissionsFields.length > 0
				? settingsSections.permissionsFields.sort()
				: undefined,
		sandboxFields:
			settingsSections.sandboxFields.length > 0
				? settingsSections.sandboxFields.sort()
				: undefined,
	};

	// --- CI Contract Gate (pre-merge) ---
	const validation = validateContracts(
		rawContracts as Record<string, string[] | undefined>,
		prev,
	);
	if (validation.warnings.length > 0) {
		console.log(pc.yellow("\n  Contract warnings:"));
		for (const w of validation.warnings) console.log(pc.yellow(`    ⚠ ${w}`));
	}
	if (validation.failed) {
		if (process.env.FORCE_CONTRACTS === "1") {
			console.log(
				pc.yellow("\n  ⚠ FORCE_CONTRACTS=1 — bypassing contract gate"),
			);
			for (const e of validation.errors) console.log(pc.yellow(`    ${e}`));
		} else {
			console.log(
				pc.red("\n  ✗ Contract gate FAILED — extraction degraded >30%:"),
			);
			for (const e of validation.errors) console.log(pc.red(`    ${e}`));
			console.log(pc.red("\n  Set FORCE_CONTRACTS=1 to override."));
			process.exit(1);
		}
	}

	// --- Merge with previous (soft merge, post-gate) ---
	const mergeWithPrevious = (
		extracted: string[] | undefined,
		field: string,
	): string[] | undefined => {
		const previous = prev[field] ?? [];
		const current = extracted ?? [];
		const merged = new Set([...previous, ...current]);
		return merged.size > 0 ? [...merged].sort() : undefined;
	};

	const contracts: Record<string, string[] | undefined> = {};
	for (const field of FIELDS) {
		contracts[field] = mergeWithPrevious(
			rawContracts[field] as string[] | undefined,
			field,
		);
	}

	const output = {
		version,
		extractedAt: new Date().toISOString(),
		contracts,
	};

	// Compute drift BEFORE writing (compares against previous file)
	const { entries } = computeDrift(contracts, outPath);
	printDrift(entries);

	// Write new contracts
	writeFileSync(outPath, JSON.stringify(output, null, "\t") + "\n");

	// Write changelog entry if --changelog flag is passed
	if (process.argv.includes("--changelog")) {
		const md = generateChangelog(version, entries, contracts);
		const changelogPath = join(rootDir, "CHANGELOG_ENTRY.md");
		writeFileSync(changelogPath, md);
		console.log(pc.cyan(`  Changelog entry written to ${changelogPath}`));
	}

	// Summary table
	console.log(pc.bold(`  Claude Code v${version} — Extracted Contracts`));
	console.log();

	const maxKeyLen = Math.max(...Object.keys(contracts).map((k) => k.length));
	for (const [key, val] of Object.entries(contracts)) {
		if (!val) continue;
		const arr = Array.isArray(val) ? val : [];
		const padded = key.padEnd(maxKeyLen);
		console.log(
			`  ${pc.white(padded)}  ${pc.bold(pc.white(String(arr.length).padStart(3)))} values  ${pc.dim(arr.join(", "))}`,
		);
	}

	console.log();
	console.log(pc.dim(`  Written to ${outPath}`));
}

// ---------------------------------------------------------------------------
// 8. Drift report
// ---------------------------------------------------------------------------

const FIELDS = [
	"tools",
	"hookEvents",
	"hookTypes",
	"promptEvents",
	"agentColors",
	"agentModels",
	"pluginJsonFields",
	"agentFrontmatter",
	"commandFrontmatter",
	"mcpServerFields",
	"skillFrontmatter",
	"settingsUserFields",
	"settingsProjectFields",
	"permissionsFields",
	"sandboxFields",
	// sandboxNetworkFields / sandboxFilesystemFields: sub-keys of sandbox.network
	// and sandbox.filesystem. Hand-curated (preserved across extractions via
	// mergeWithPrevious) — their Zod schemas are reached only through minified
	// references, so there is no stable anchor.
	"sandboxNetworkFields",
	"sandboxFilesystemFields",
	// permissionModes: valid values for permissions.defaultMode. Hand-curated
	// (preserved across extractions via mergeWithPrevious) — the runtime enum
	// reference is renamed by minification, so there is no stable anchor.
	"permissionModes",
	// pluginSubagentBlockedTools: hand-curated list of tool names that are
	// declared in agent frontmatter but never reach the runtime tool schema
	// of plugin-defined subagents. Tracked upstream:
	//   https://github.com/anthropics/claude-code/issues/52055
	//   https://github.com/anthropics/claude-code/issues/52004
	// Not auto-extracted from cli.js — this set is preserved across
	// extractions via mergeWithPrevious. Update by editing the JSON file
	// directly when the upstream bug list changes.
	"pluginSubagentBlockedTools",
];

const LABELS: Record<string, string> = {
	tools: "Tools",
	hookEvents: "Hook Events",
	hookTypes: "Hook Types",
	promptEvents: "Prompt Events",
	agentColors: "Agent Colors",
	agentModels: "Agent Models",
	pluginJsonFields: "Plugin JSON Fields",
	agentFrontmatter: "Agent Frontmatter",
	commandFrontmatter: "Command Frontmatter",
	mcpServerFields: "MCP Server Fields",
	skillFrontmatter: "Skill Frontmatter",
	settingsUserFields: "Settings (User)",
	settingsProjectFields: "Settings (Project)",
	permissionsFields: "Permissions Fields",
	sandboxFields: "Sandbox Fields",
	sandboxNetworkFields: "Sandbox Network Fields",
	sandboxFilesystemFields: "Sandbox Filesystem Fields",
	permissionModes: "Permission Modes",
	pluginSubagentBlockedTools: "Plugin Subagent Blocked Tools",
};

interface DriftEntry {
	label: string;
	added: string[];
	removed: string[];
}

function computeDrift(
	newContracts: Record<string, string[] | undefined>,
	outPath: string,
): { entries: DriftEntry[]; prev: Record<string, string[]> } {
	let prev: Record<string, string[]> = {};
	try {
		const existing = JSON.parse(readFileSync(outPath, "utf8"));
		prev = existing.contracts ?? {};
	} catch {
		// First run — no previous file
	}

	const entries: DriftEntry[] = [];
	for (const field of FIELDS) {
		const extracted = newContracts[field] ?? [];
		const current = prev[field] ?? [];
		entries.push({
			label: LABELS[field],
			added: extracted.filter((v) => !current.includes(v)),
			removed: current.filter((v) => !extracted.includes(v)),
		});
	}
	return { entries, prev };
}

function printDrift(entries: DriftEntry[]) {
	console.log();
	console.log(pc.bold("  Drift Report — New vs Previous Contracts"));
	console.log();

	const maxLabelLen = Math.max(...entries.map((e) => e.label.length));
	let okCount = 0;
	let driftCount = 0;

	for (const { label, added, removed } of entries) {
		const padded = label.padEnd(maxLabelLen);

		if (added.length === 0 && removed.length === 0) {
			okCount++;
			console.log(`  ${pc.green("✓")} ${padded}  ${pc.dim("unchanged")}`);
		} else {
			driftCount++;
			console.log(
				`  ${pc.yellow("⚠")} ${pc.yellow(padded)}  ${pc.yellow("changed")}`,
			);
			if (added.length) {
				console.log(
					`    ${pc.green("+")} ${pc.green(added.join(pc.dim(", ")))}`,
				);
			}
			if (removed.length) {
				console.log(`    ${pc.red("−")} ${pc.red(removed.join(pc.dim(", ")))}`);
			}
		}
	}

	console.log();
	if (driftCount === 0) {
		console.log(pc.green(pc.bold("  No changes from previous extraction.")));
	} else {
		console.log(
			`  ${pc.green(pc.bold(`${okCount} unchanged`))}, ${pc.yellow(pc.bold(`${driftCount} changed`))} — run ${pc.cyan("npm run generate-contracts")} to update linter constants.`,
		);
	}
	console.log();
}

function generateChangelog(
	version: string,
	entries: DriftEntry[],
	contracts: Record<string, string[] | undefined>,
): string {
	const date = new Date().toISOString().slice(0, 10);
	const lines: string[] = [];

	lines.push(`## ${version} (${date})`);
	lines.push("");
	lines.push(`Synced with Claude Code v${version}.`);
	lines.push("");

	const changed = entries.filter(
		(e) => e.added.length > 0 || e.removed.length > 0,
	);
	if (changed.length > 0) {
		lines.push("### Changes");
		lines.push("");
		for (const { label, added, removed } of changed) {
			const parts: string[] = [];
			if (added.length) parts.push(`+${added.join(", +")}`);
			if (removed.length) parts.push(`-${removed.join(", -")}`);
			lines.push(`- **${label}**: ${parts.join("; ")}`);
		}
		lines.push("");
	}

	lines.push("### Contract Summary");
	lines.push("");
	lines.push("| Category | Count | Values |");
	lines.push("|----------|------:|--------|");
	for (const field of FIELDS) {
		const arr = contracts[field] ?? [];
		if (arr.length === 0) continue;
		const label = LABELS[field];
		const truncated =
			arr.length > 10
				? arr.slice(0, 10).join(", ") + `, … (${arr.length} total)`
				: arr.join(", ");
		lines.push(`| ${label} | ${arr.length} | ${truncated} |`);
	}
	lines.push("");

	return lines.join("\n");
}

// Only run main() when executed directly, not when imported for testing
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	main();
}
