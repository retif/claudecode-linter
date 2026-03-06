import { describe, it, expect } from "vitest";
import { extractTopLevelKeys } from "../../scripts/extract-contracts.js";

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
