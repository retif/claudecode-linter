import { describe, it, expect } from "vitest";
import { extractTopLevelKeys, collectObjectKeySets, classifyByOverlap, parseToolsDts, validateContracts } from "../../scripts/extract-contracts.js";
import * as acorn from "acorn";

function parseCode(code: string) {
	return acorn.parse(code, { sourceType: "module", ecmaVersion: "latest" }) as acorn.Program;
}

describe("extractTopLevelKeys", () => {
	it("extracts basic keys", () => {
		const keys = extractTopLevelKeys('{name:"",version:""}');
		expect(keys).toEqual(["name", "version"]);
	});

	it("extracts keys with nested objects", () => {
		const keys = extractTopLevelKeys('{config:{nested:true},other:""}');
		expect(keys).toEqual(["config", "other"]);
	});

	it("extracts keys from spread objects", () => {
		const keys = extractTopLevelKeys('{...{a:I.boolean()},b:""}');
		expect(keys).toEqual(["a", "b"]);
	});

	it("extracts keys with chained methods", () => {
		const keys = extractTopLevelKeys(
			"{name:I.string().optional(),age:I.number()}",
		);
		expect(keys).toEqual(["name", "age"]);
	});

	it("does not match quoted string keys with dashes (unsupported)", () => {
		// The regex uses \w+ which does not match hyphens inside quoted keys
		const keys = extractTopLevelKeys('{"key-with-dashes":"value"}');
		expect(keys).toEqual([]);
	});

	it("extracts keys prefixed with $", () => {
		const keys = extractTopLevelKeys("{$schema:I.string(),name:I.string()}");
		expect(keys).toEqual(["$schema", "name"]);
	});

	it("handles deeply nested braces", () => {
		const keys = extractTopLevelKeys("{a:{b:{c:{d:true}}},e:I.string()}");
		expect(keys).toEqual(["a", "e"]);
	});

	it("returns empty array for empty object", () => {
		const keys = extractTopLevelKeys("{}");
		expect(keys).toEqual([]);
	});
});

describe("collectObjectKeySets", () => {
	it("collects keys from object expressions with 3+ keys", () => {
		const ast = parseCode("const x = { name: 1, version: 2, description: 3 }");
		const sets = collectObjectKeySets(ast);
		expect(sets.length).toBeGreaterThanOrEqual(1);
		expect(sets.some(s =>
			s.keys.includes("name") && s.keys.includes("version") && s.keys.includes("description")
		)).toBe(true);
	});

	it("skips objects with fewer than 3 keys", () => {
		const ast = parseCode("const x = { a: 1, b: 2 }");
		const sets = collectObjectKeySets(ast);
		expect(sets.every(s => s.keys.length >= 3)).toBe(true);
	});

	it("skips objects with more than 150 keys", () => {
		const keys = Array.from({ length: 160 }, (_, i) => `k${i}: ${i}`).join(", ");
		const ast = parseCode(`const x = { ${keys} }`);
		const sets = collectObjectKeySets(ast);
		expect(sets.every(s => s.keys.length <= 150)).toBe(true);
	});

	it("deduplicates identical key sets", () => {
		const ast = parseCode("const x = { a: 1, b: 2, c: 3 }; const y = { a: 4, b: 5, c: 6 }");
		const sets = collectObjectKeySets(ast);
		const matching = sets.filter(s =>
			s.keys.length === 3 && s.keys.includes("a") && s.keys.includes("b") && s.keys.includes("c")
		);
		expect(matching.length).toBe(1);
	});

	it("handles computed property keys by skipping them", () => {
		const ast = parseCode("const x = { name: 1, [expr]: 2, version: 3, desc: 4 }");
		const sets = collectObjectKeySets(ast);
		expect(sets.some(s => s.keys.includes("name") && s.keys.includes("version"))).toBe(true);
	});
});

describe("classifyByOverlap", () => {
	const knownPluginFields = ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"];

	it("picks the set with highest overlap score", () => {
		const sets = [
			{ keys: ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"], pos: 0 },
			{ keys: ["name", "value", "type", "label"], pos: 100 },
			{ keys: ["x", "y", "z", "w"], pos: 200 },
		];
		const result = classifyByOverlap(sets, knownPluginFields);
		expect(result).toEqual(["name", "version", "description", "author", "homepage", "repository", "license", "keywords"]);
	});

	it("returns empty array when no set meets minimum overlap floor of 3", () => {
		const sets = [
			{ keys: ["name", "version", "other1", "other2", "other3"], pos: 0 },
		];
		const result = classifyByOverlap(sets, knownPluginFields);
		expect(result).toEqual([]);
	});

	it("returns empty array when no set meets minimum score of 0.3", () => {
		const sets = [
			{ keys: ["name", "version", "description", ...Array.from({ length: 47 }, (_, i) => `other${i}`)], pos: 0 },
		];
		const result = classifyByOverlap(sets, knownPluginFields);
		expect(result).toEqual([]);
	});

	it("includes new keys from winning set", () => {
		const sets = [
			{ keys: ["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "newField"], pos: 0 },
		];
		const result = classifyByOverlap(sets, knownPluginFields);
		expect(result).toContain("newField");
	});

	it("breaks ties by size proximity to known set", () => {
		const sets = [
			{ keys: ["name", "version", "description", "author", "extra1", "extra2", "extra3", "extra4"], pos: 0 },
			{ keys: ["name", "version", "description", "author"], pos: 100 },
		];
		const result = classifyByOverlap(sets, knownPluginFields);
		expect(result?.length).toBe(8);
	});

	it("returns empty array for empty input", () => {
		expect(classifyByOverlap([], knownPluginFields)).toEqual([]);
	});
});

describe("parseToolsDts", () => {
	it("extracts tool names from interface declarations", () => {
		const dts = `
export interface BashInput { command: string; }
export interface BashOutput { stdout: string; }
export interface FileReadInput { path: string; }
export interface GrepInput { pattern: string; }
`;
		const tools = parseToolsDts(dts);
		expect(tools).toContain("Bash");
		expect(tools).toContain("Read");
		expect(tools).toContain("Grep");
	});

	it("applies name mappings for FileRead/FileEdit/FileWrite", () => {
		const dts = `
export interface FileReadInput { path: string; }
export interface FileEditInput { path: string; }
export interface FileWriteInput { path: string; }
`;
		const tools = parseToolsDts(dts);
		expect(tools).toContain("Read");
		expect(tools).toContain("Edit");
		expect(tools).toContain("Write");
		expect(tools).not.toContain("FileRead");
		expect(tools).not.toContain("FileEdit");
		expect(tools).not.toContain("FileWrite");
	});

	it("returns empty array for empty/invalid input", () => {
		expect(parseToolsDts("")).toEqual([]);
		expect(parseToolsDts("no interfaces here")).toEqual([]);
	});

	it("does not include Output-only interfaces", () => {
		const dts = `export interface AgentOutput { result: string; }`;
		const tools = parseToolsDts(dts);
		expect(tools).not.toContain("Agent");
	});
});

describe("validateContracts", () => {
	const previous = {
		tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "AskUserQuestion"],
		hookEvents: ["PreToolUse", "PostToolUse", "Stop", "SessionStart", "UserPromptSubmit"],
		pluginJsonFields: ["name", "version", "description", "author"],
	};

	it("passes when no values are lost", () => {
		const raw = { ...previous };
		const result = validateContracts(raw, previous);
		expect(result.failed).toBe(false);
		expect(result.errors).toEqual([]);
	});

	it("passes with warnings when 1-30% values lost", () => {
		const raw = {
			...previous,
			tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
		};
		const result = validateContracts(raw, previous);
		expect(result.failed).toBe(false);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("fails when >30% values lost in a category", () => {
		const raw = {
			...previous,
			tools: ["Read", "Write", "Edit"],
		};
		const result = validateContracts(raw, previous);
		expect(result.failed).toBe(true);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("tools");
	});

	it("skips categories not in previous (new categories)", () => {
		const raw = {
			...previous,
			newCategory: ["a", "b", "c"],
		};
		const result = validateContracts(raw, previous);
		expect(result.failed).toBe(false);
	});

	it("skips categories with empty previous (nothing to compare)", () => {
		const prev = { ...previous, hookTypes: [] as string[] };
		const raw = { ...previous, hookTypes: [] as string[] };
		const result = validateContracts(raw, prev);
		expect(result.failed).toBe(false);
	});

	it("passes when extraction grows", () => {
		const raw = {
			...previous,
			tools: [...previous.tools, "NewTool1", "NewTool2"],
		};
		const result = validateContracts(raw, previous);
		expect(result.failed).toBe(false);
	});
});
