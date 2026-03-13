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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fetchCliSource(requestedVersion?: string): {
	source: string;
	version: string;
	sdkToolsDts: string | null;
} {
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
		const source = readFileSync(join(tmp, "package", "cli.js"), "utf8");

		let sdkToolsDts: string | null = null;
		try {
			sdkToolsDts = readFileSync(join(tmp, "package", "sdk-tools.d.ts"), "utf8");
		} catch {
			// File may not exist in all versions
		}

		return { source, version: pkg.version, sdkToolsDts };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
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

function collectStringSets(ast: acorn.Program): StringSet[] {
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
				if (strings) results.push({ values: strings, pos: node.start });
			}
		},
		ArrayExpression(node: any) {
			const strings = extractStringArrayElements(node);
			if (strings && strings.length >= 3) {
				results.push({ values: strings, pos: node.start });
			}
		},
	});

	return results;
}

// ---------------------------------------------------------------------------
// 2b. Object key census
// ---------------------------------------------------------------------------

export type ObjectKeySet = { keys: string[]; pos: number };

export function collectObjectKeySets(ast: acorn.Program): ObjectKeySet[] {
	const results: ObjectKeySet[] = [];
	const seen = new Set<string>();

	walk.simple(ast, {
		ObjectExpression(node: any) {
			const keys: string[] = [];
			for (const prop of node.properties) {
				if (prop.type === "SpreadElement") continue;
				if (prop.computed) continue;
				if (prop.key.type === "Identifier") {
					keys.push(prop.key.name);
				} else if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
					keys.push(prop.key.value);
				}
			}
			if (keys.length < 3 || keys.length > 150) return;

			const signature = [...keys].sort().join(",");
			if (seen.has(signature)) return;
			seen.add(signature);

			results.push({ keys, pos: node.start });
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
		const intersectionCount = s.keys.filter(k => knownSet.has(k)).length;
		if (intersectionCount < MIN_OVERLAP_FLOOR) continue;

		const score = intersectionCount / Math.max(s.keys.length, knownValues.length);
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

/**
 * Find a Zod I.object({...}) block containing the given anchor string.
 * Returns its top-level keys.
 */
function extractZodObjectKeys(source: string, anchor: string): string[] {
	const anchorIdx = source.indexOf(anchor);
	if (anchorIdx === -1) return [];

	const objStart = source.lastIndexOf("I.object({", anchorIdx);
	if (objStart === -1) return [];
	const braceStart = objStart + "I.object(".length;

	const block = extractBalancedBlock(source, braceStart);
	if (!block) return [];
	return extractTopLevelKeys(block);
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
		const lost = prevValues.filter(v => !extractedSet.has(v));
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

function extractAllToolNames(source: string): string[] {
	const candidates = new Set<string>();

	// Scan for known tool name string literals
	const toolLiteralPattern =
		/["'](Read|Write|Edit|Bash|Glob|Grep|WebFetch|WebSearch|Agent|AskUserQuestion|NotebookEdit|NotebookRead|TodoWrite|EnterPlanMode|ExitPlanMode|Skill|EnterWorktree|SendMessage|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskStop|TaskOutput|TeamCreate|TeamDelete|ToolSearch|LSP)["']/g;
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

function extractSettingsProjectFields(source: string): string[] {
	const fields = extractZodObjectKeys(
		source,
		'.describe("List of tools the project is allowed to use")',
	);
	return fields.length > 0 ? fields : ["permissions"];
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

	const label = requestedVersion ? `v${requestedVersion}` : "latest";
	console.log(pc.cyan(`▸ Fetching @anthropic-ai/claude-code (${label})...`));
	const { source, version, sdkToolsDts } = fetchCliSource(requestedVersion);
	console.log(
		pc.cyan("▸ Parsing AST"),
		pc.dim(`(v${version}, ${(source.length / 1e6).toFixed(1)}MB)`),
	);

	const ast = acorn.parse(source, {
		sourceType: "module",
		ecmaVersion: "latest",
	}) as acorn.Program;

	const stringSets = collectStringSets(ast);
	const objectKeySets = collectObjectKeySets(ast);
	console.log(
		pc.cyan("▸ Extracting contracts..."),
		pc.dim(`(${stringSets.length} string sets, ${objectKeySets.length} object-key sets)`),
	);

	// --- String-set classification (tools, events, colors — already robust) ---
	const classified = classifySets(stringSets);
	const allTools = extractAllToolNames(source);

	// --- d.ts cross-validation for tools ---
	if (sdkToolsDts) {
		const dtsTools = parseToolsDts(sdkToolsDts);
		const censusTools = new Set(allTools);
		const missingFromCensus = dtsTools.filter(t => !censusTools.has(t));
		if (missingFromCensus.length > 0) {
			console.log(pc.yellow(`  ⚠ Tools in sdk-tools.d.ts but not in bundle: ${missingFromCensus.join(", ")}`));
			// Add them — d.ts is authoritative for SDK tools
			for (const t of missingFromCensus) allTools.push(t);
			allTools.sort();
		}
	} else {
		console.log(pc.yellow("  ⚠ sdk-tools.d.ts not found in package — skipping d.ts cross-validation"));
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

	const pluginFields = classifyByOverlap(objectKeySets, prev["pluginJsonFields"] ?? []);
	const agentFields = classifyByOverlap(objectKeySets, prev["agentFrontmatter"] ?? []);
	const commandFields = classifyByOverlap(objectKeySets, prev["commandFrontmatter"] ?? []);
	const mcpFieldsCensus = classifyByOverlap(objectKeySets, prev["mcpServerFields"] ?? []);
	const mcpFieldsFallback = extractMcpServerFields(source);
	const mcpFields = [...new Set([...mcpFieldsCensus, ...mcpFieldsFallback])];
	const settingsUserFields = classifyByOverlap(objectKeySets, prev["settingsUserFields"] ?? []);
	const skillFieldsCensus = classifyByOverlap(objectKeySets, prev["skillFrontmatter"] ?? []);
	const skillFieldsFallback = extractSkillFrontmatter(source);
	const skillFields = [...new Set([...skillFieldsCensus, ...skillFieldsFallback])].sort();

	// Small enum sets: union census + anchor fallback results
	const agentModelEnum = [...new Set([
		...classifyByOverlap(objectKeySets, prev["agentModels"] ?? []),
		...extractAgentModelEnum(source),
	])];
	// hookTypes and promptEvents: small/subset categories where census matches
	// the same object as hookEvents. Use dedicated extractors only.
	const hookTypes = extractHookTypes(source);
	const promptEvents = extractPromptEvents(source);

	// settingsProjectFields: single-value category, keep anchor fallback
	const settingsProjectFields = extractSettingsProjectFields(source);

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
			const colors = longestArray(classified.agentColors);
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
		settingsUserFields: settingsUserFields.length > 0 ? settingsUserFields.sort() : undefined,
		settingsProjectFields: settingsProjectFields.length > 0 ? settingsProjectFields.sort() : undefined,
	};

	// --- CI Contract Gate (pre-merge) ---
	const validation = validateContracts(rawContracts as Record<string, string[] | undefined>, prev);
	if (validation.warnings.length > 0) {
		console.log(pc.yellow("\n  Contract warnings:"));
		for (const w of validation.warnings) console.log(pc.yellow(`    ⚠ ${w}`));
	}
	if (validation.failed) {
		if (process.env.FORCE_CONTRACTS === "1") {
			console.log(pc.yellow("\n  ⚠ FORCE_CONTRACTS=1 — bypassing contract gate"));
			for (const e of validation.errors) console.log(pc.yellow(`    ${e}`));
		} else {
			console.log(pc.red("\n  ✗ Contract gate FAILED — extraction degraded >30%:"));
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
		contracts[field] = mergeWithPrevious(rawContracts[field] as string[] | undefined, field);
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
