/**
 * Unit tests for the Zod walker in scripts/extract-plugin-schema.ts.
 *
 * These tests run against in-memory bundle fragments, not the live cli.js, so
 * they remain stable across Claude Code releases. They cover the core eval
 * primitives, the chain splitter, the spread parser, and master-schema
 * composition.
 */

import { describe, it, expect } from "vitest";
import {
	evalZod,
	indexDefinitions,
	parseMasterSpread,
	splitChain,
	splitTopLevelArgs,
	parseEntry,
	findSymbolByAnchor,
	buildPluginSchema,
} from "../../scripts/extract-plugin-schema.js";

/**
 * Build a minimal in-memory bundle so we can exercise the full extractor
 * pipeline. The shape mimics Claude Code's bundle: comma-separated `<name>=...`
 * declarations, all wrapped in `var ... = T(()=> ...)` lazy initializers, with
 * an `E.<method>` Zod alias and a `kebab-case` anchor for master detection.
 */
function makeBundle(): string {
	const parts: string[] = [];
	parts.push("var ");
	parts.push(
		// authorSchema: required name + optional email
		`authorSchema=CH(()=>E.object({name:E.string().min(1).describe("author name"),email:E.string().optional().describe("contact email")}))`,
	);
	parts.push(
		// coreSchema (required fields)
		`,coreSchema=CH(()=>E.object({name:E.string().min(1).describe("plugin name"),version:E.string().optional().describe("semver")}))`,
	);
	parts.push(
		// extrasSchema (all optional)
		`,extrasSchema=CH(()=>E.object({description:E.string().optional().describe("desc"),author:authorSchema().optional().describe("author")}))`,
	);
	parts.push(
		// MASTER (mimics CSH=CH(()=>E.object({...spread...})))
		`,masterSchema=CH(()=>E.object({...coreSchema().shape,...extrasSchema().partial().shape}))`,
	);
	parts.push(";");
	// Provide the kebab-case anchor near a strict().safeParse call so
	// findMasterSchemaName resolves to "masterSchema".
	parts.push(
		`function validate(z){let Y=masterSchema().strict().safeParse(z); if(!Y.success && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(z.name)) throw new Error('name is not kebab-case'); }`,
	);
	return parts.join("");
}

describe("splitTopLevelArgs", () => {
	it("splits a simple comma-separated list", () => {
		expect(splitTopLevelArgs("a, b, c")).toEqual(["a", "b", "c"]);
	});

	it("ignores commas inside nested parens", () => {
		expect(splitTopLevelArgs("a, foo(b, c), d")).toEqual([
			"a",
			"foo(b, c)",
			"d",
		]);
	});

	it("ignores commas inside string literals", () => {
		expect(splitTopLevelArgs('a, "b, c", d')).toEqual(["a", '"b, c"', "d"]);
	});

	it("handles escaped quotes inside strings", () => {
		expect(splitTopLevelArgs('a, "b\\"c", d')).toEqual(["a", '"b\\"c"', "d"]);
	});
});

describe("splitChain", () => {
	it("keeps E.method() as the single head term", () => {
		expect(splitChain("E.object({a:1})")).toEqual(["E.object({a:1})"]);
	});

	it("splits trailing method calls after a close paren", () => {
		expect(splitChain("E.string().optional()")).toEqual([
			"E.string()",
			"optional()",
		]);
	});

	it("does not split dots inside nested literals", () => {
		expect(splitChain("E.object({a:b.c.d}).optional()")).toEqual([
			"E.object({a:b.c.d})",
			"optional()",
		]);
	});
});

describe("parseEntry", () => {
	it("parses bare identifier keys", () => {
		expect(parseEntry("name:E.string()")).toEqual({
			key: "name",
			value: "E.string()",
		});
	});

	it("parses string-quoted keys", () => {
		expect(parseEntry('"$schema":E.string()')).toEqual({
			key: "$schema",
			value: "E.string()",
		});
	});

	it("ignores colons inside nested calls", () => {
		expect(parseEntry("name:E.record(K, V)")).toEqual({
			key: "name",
			value: "E.record(K, V)",
		});
	});
});

describe("evalZod primitives", () => {
	const ctx = {
		index: indexDefinitions(makeBundle()),
		resolving: new Set<string>(),
	};

	it("translates E.string() → {type: string}", () => {
		expect(evalZod("E.string()", ctx)).toEqual({ type: "string" });
	});

	it("translates E.number() → {type: number}", () => {
		expect(evalZod("E.number()", ctx)).toEqual({ type: "number" });
	});

	it("translates E.boolean() → {type: boolean}", () => {
		expect(evalZod("E.boolean()", ctx)).toEqual({ type: "boolean" });
	});

	it('translates E.literal("x") → {const: x}', () => {
		expect(evalZod('E.literal("x")', ctx)).toEqual({ const: "x" });
	});

	it("translates E.enum([...]) → {enum: [...]}", () => {
		expect(evalZod('E.enum(["a","b","c"])', ctx)).toEqual({
			enum: ["a", "b", "c"],
		});
	});

	it("translates E.array(E.string()) → {type: array, items: ...}", () => {
		expect(evalZod("E.array(E.string())", ctx)).toEqual({
			type: "array",
			items: { type: "string" },
		});
	});

	it("translates E.record(K, V) → additionalProperties: V", () => {
		expect(evalZod("E.record(E.string(), E.number())", ctx)).toEqual({
			type: "object",
			additionalProperties: { type: "number" },
		});
	});

	it("translates E.union([A, B]) → anyOf", () => {
		expect(evalZod("E.union([E.string(),E.number()])", ctx)).toEqual({
			anyOf: [{ type: "string" }, { type: "number" }],
		});
	});

	it("translates E.discriminatedUnion → oneOf", () => {
		const out = evalZod(
			'E.discriminatedUnion("kind", [E.object({kind:E.literal("a"),x:E.string()}),E.object({kind:E.literal("b"),y:E.number()})])',
			ctx,
		);
		expect(out.oneOf).toBeDefined();
		expect((out.oneOf as object[]).length).toBe(2);
	});

	it("applies .strict() → additionalProperties: false", () => {
		const out = evalZod("E.object({a:E.string()}).strict()", ctx);
		expect(out.additionalProperties).toBe(false);
	});

	it("translates E.strictObject directly", () => {
		const out = evalZod("E.strictObject({a:E.string()})", ctx);
		expect(out.additionalProperties).toBe(false);
		expect((out.properties as Record<string, object>).a).toEqual({
			type: "string",
		});
	});

	it("applies .partial() → drops required[]", () => {
		const out = evalZod("E.object({a:E.string(),b:E.string()}).partial()", ctx);
		expect(out.required).toBeUndefined();
	});

	it("treats .optional() as removing key from required", () => {
		const out = evalZod(
			"E.object({a:E.string(),b:E.string().optional()})",
			ctx,
		);
		expect(out.required).toEqual(["a"]);
	});

	it("attaches .describe() text as JSON Schema description", () => {
		const out = evalZod('E.string().describe("hello world")', ctx);
		expect(out.description).toBe("hello world");
	});

	it("translates .min() to minLength for strings", () => {
		const out = evalZod("E.string().min(3)", ctx);
		expect(out).toEqual({ type: "string", minLength: 3 });
	});

	it("ignores .refine() (predicate-based, unrepresentable)", () => {
		const out = evalZod("E.string().refine((x)=>x.length>0)", ctx);
		expect(out).toEqual({ type: "string" });
	});

	it("strips preprocess(transformFn, innerSchema) to the inner schema", () => {
		const out = evalZod("E.preprocess((x)=>x,E.object({a:E.string()}))", ctx);
		expect((out.properties as Record<string, object>).a).toEqual({
			type: "string",
		});
	});

	it("translates E.partialRecord(K, V) like E.record", () => {
		expect(evalZod("E.partialRecord(E.string(), E.number())", ctx)).toEqual({
			type: "object",
			additionalProperties: { type: "number" },
		});
	});

	it("resolves E.enum(<identifier>) via the indexed array literal", () => {
		// `evCfg` is declared as a plain string-array in the bundle fragment.
		const local = {
			index: indexDefinitions(
				'var evCfg=["one","two","three"];authorSchema=CH(()=>E.object({a:E.string()}))',
			),
			resolving: new Set<string>(),
		};
		expect(evalZod("E.enum(evCfg)", local)).toEqual({
			enum: ["one", "two", "three"],
		});
	});

	it("resolves a block-body factory that destructures a helper", () => {
		// Mirrors Claude Code's hook-entry schema: a block-body arrow that
		// destructures named sub-schemas out of a helper function, then composes
		// them into a discriminatedUnion.
		const bundle =
			"function Hb(){let H=E.object({type:E.literal(\"command\"),cmd:E.string()})," +
			"$=E.object({type:E.literal(\"prompt\"),prompt:E.string()});" +
			"return{A:H,B:$}}" +
			",entrySchema=CH(()=>{let{A:H,B:$}=Hb();return E.discriminatedUnion(\"type\",[H,$])})";
		const local = {
			index: indexDefinitions(bundle),
			resolving: new Set<string>(),
		};
		const def = local.index.defs.get("entrySchema");
		expect(def).toBeDefined();
		const out = evalZod(def as string, local);
		expect(out.oneOf).toBeDefined();
		expect((out.oneOf as object[]).length).toBe(2);
	});

	it("handles spread inside object body", () => {
		const out = evalZod(
			"E.object({...authorSchema().shape,extra:E.boolean()})",
			ctx,
		);
		const props = out.properties as Record<string, object>;
		expect(props.name).toEqual({
			type: "string",
			minLength: 1,
			description: "author name",
		});
		expect(props.email).toEqual({
			type: "string",
			description: "contact email",
		});
		expect(props.extra).toEqual({ type: "boolean" });
	});
});

describe("indexDefinitions + master parsing", () => {
	const source = makeBundle();
	const idx = indexDefinitions(source);

	it("detects the Zod alias", () => {
		expect(idx.zodAlias).toBe("E");
	});

	it("detects the lazy wrapper", () => {
		expect(idx.lazyWrapper).toBe("CH");
	});

	it("indexes top-level schema definitions", () => {
		expect(idx.defs.has("authorSchema")).toBe(true);
		expect(idx.defs.has("coreSchema")).toBe(true);
		expect(idx.defs.has("extrasSchema")).toBe(true);
		expect(idx.defs.has("masterSchema")).toBe(true);
	});

	it("parseMasterSpread returns required + partial refs", () => {
		const masterDef = idx.defs.get("masterSchema")!;
		const refs = parseMasterSpread(masterDef, idx.zodAlias, idx.lazyWrapper);
		expect(refs).toEqual([
			{ name: "coreSchema", partial: false },
			{ name: "extrasSchema", partial: true },
		]);
	});

	it("findSymbolByAnchor walks back from an in-source string", () => {
		const name = findSymbolByAnchor(idx, "author name");
		expect(name).toBe("authorSchema");
	});

	it("buildPluginSchema composes the master correctly", () => {
		const schema = buildPluginSchema(idx);
		const props = schema.properties as Record<string, object>;
		expect(Object.keys(props).sort()).toEqual([
			"author",
			"description",
			"name",
			"version",
		]);
		// `name` required (from coreSchema which is NOT partial);
		// extras (description, author) are .partial() → not required.
		expect(schema.required).toEqual(["name"]);
	});
});
