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
	findMasterSchemaName,
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

	it("resolves E.literal(<ident>) via the string-literal index", () => {
		// gitea#1 regression: `y.literal(V0q)` with `V0q="https://..."` must
		// resolve to the URL, not surface as `{ const: "V0q" }`.
		const idx = indexDefinitions(
			`V0q="https://json.schemastore.org/claude-code-settings.json";` +
			`var s=CH(()=>E.object({$schema:E.literal(V0q).optional()}));`,
		);
		const ctx2 = { index: idx, resolving: new Set<string>() };
		expect(evalZod("E.literal(V0q)", ctx2)).toEqual({
			const: "https://json.schemastore.org/claude-code-settings.json",
		});
	});

	it("E.literal(<unknown-ident>) falls back to {type:string} (never a bogus const)", () => {
		expect(evalZod("E.literal(unknownIdent)", ctx)).toEqual({ type: "string" });
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

	it("resolves bare-alias factories (LW/lFH -> z36) to the real schema", () => {
		// Claude Code's frontmatter fields are typed through alias chains:
		//   z36=()=>y.union([y.string(),y.number(),y.boolean(),y.null()]),LW,lFH
		//   ...later... LW=z36,lFH=z36
		// `name:LW().optional()` must resolve to z36's union, not a `{}` stub.
		const bundle =
			"z36=()=>E.union([E.string(),E.number(),E.boolean(),E.null()]),LW,lFH," +
			"fmSchema=CH(()=>E.object({" +
			'name:LW().optional().describe("display name"),' +
			'flag:lFH().optional().describe("a boolean-ish field")}))' +
			",LW=z36,lFH=z36";
		const local = {
			index: indexDefinitions(bundle),
			resolving: new Set<string>(),
		};
		// The alias pass records `LW`/`lFH` as `z36()` so the chain follows
		// `LW -> z36() -> ()=>E.union([...])`.
		expect(local.index.defs.get("LW")).toBe("z36()");
		expect(local.index.defs.get("lFH")).toBe("z36()");
		const def = local.index.defs.get("fmSchema");
		expect(def).toBeDefined();
		const out = evalZod(def as string, local);
		const props = out.properties as Record<string, object>;
		const union = [
			{ type: "string" },
			{ type: "number" },
			{ type: "boolean" },
			{ type: "null" },
		];
		expect(props.name).toEqual({
			anyOf: union,
			description: "display name",
		});
		expect(props.flag).toEqual({
			anyOf: union,
			description: "a boolean-ish field",
		});
		// All fields are `.optional()` — none required.
		expect(out.required).toBeUndefined();
	});

	it("follows multi-hop alias chains to the backing factory", () => {
		// `A=B,B=z36` — the alias pass walks the chain to the first symbol that
		// is an indexed factory and records the alias as a direct call to it.
		const bundle =
			"z36=()=>E.union([E.string(),E.null()]),A,B," +
			"fmSchema=CH(()=>E.object({x:A()}));" +
			"B=z36;A=B;";
		const local = {
			index: indexDefinitions(bundle),
			resolving: new Set<string>(),
		};
		// Both aliases are registered and bottom out in the `z36` factory —
		// either as a direct `z36()` call or via the chained `B()` indirection,
		// both of which the chain evaluator resolves identically.
		expect(local.index.defs.get("B")).toBe("z36()");
		expect(local.index.defs.get("A")).toMatch(/^(z36|B)\(\)$/);
		const out = evalZod(local.index.defs.get("fmSchema") as string, local);
		expect((out.properties as Record<string, object>).x).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("does not mistake a non-factory `<name>=<ident>` for a schema", () => {
		// `Q=process` is not a Zod alias — it must not become a resolvable def.
		const bundle =
			"z36=()=>E.string(),Q=process,fmSchema=CH(()=>E.object({y:E.number()}))";
		const idx = indexDefinitions(bundle);
		expect(idx.defs.has("Q")).toBe(false);
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

/**
 * Enough unrelated code to push the kebab-case error string out of strategy 1's
 * 4000-character backward window.
 *
 * Deliberately a second copy of the helper in
 * `extract-plugin-schema-validator-collision.test.ts` rather than a shared
 * import: these two files pin different mechanisms and neither should be able
 * to weaken the other's fixtures by editing one helper (oleks/claudecode-linter#40).
 */
function pad(): string {
	return `var PAD="${"x".repeat(5000)}";`;
}

/**
 * Build a 2.1.197+-shaped bundle where the master schema is NO LONGER validated
 * inline next to the "is not kebab-case" string. Instead a hand-rolled
 * imperative linter owns that string, and the Zod schema is validated inside a
 * generic validator (`KWe`) dispatched by artifact-type string
 * (`KWe(candidate,"plugin-json",{…})`), whose body calls `<master>().safeParse`.
 *
 * The `pad()` between the validator and the linter is what makes this fixture
 * DISCRIMINATING. Without it `masterSchema().safeParse(` sits ~200 characters
 * from "is not kebab-case", strategy 1 answers from the adjacency alone, and
 * every assertion below passes with strategy 2 fully removed — which is exactly
 * how this block sat green while pinning nothing (oleks/claudecode-linter#40).
 * Real bundles have not had the two adjacent since 2.1.197; that separation is
 * the whole reason strategy 2 exists.
 */
function makeTypeDispatchBundle(): string {
	const parts: string[] = [];
	parts.push("var ");
	parts.push(
		`coreSchema=CH(()=>E.object({name:E.string().min(1),version:E.string().optional()}))`,
	);
	parts.push(
		`,extrasSchema=CH(()=>E.object({description:E.string().optional()}))`,
	);
	parts.push(
		`,masterSchema=CH(()=>E.object({...coreSchema().shape,...extrasSchema().partial().shape}))`,
	);
	parts.push(";");
	// Generic validator, invoked with the "plugin-json" type string. Its body
	// calls `masterSchema().safeParse(...)` — the only safeParse in the bundle.
	parts.push(
		`function KWe(e,t,n){let o={...e},a=masterSchema().safeParse(o);return a.success?{ok:!0}:{ok:!1}}`,
	);
	// Push the kebab-case string out of strategy 1's reach, as the real bundle
	// does with megabytes of unrelated modules.
	parts.push(pad());
	// Hand-rolled linter owning the kebab-case string, NOT adjacent to safeParse.
	parts.push(
		`function lintManifest(m,r){let i=KWe(m,"plugin-json",{manifestPath:r});if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name))push({path:"name",message:\`Plugin name "\${m.name}" is not kebab-case.\`})}`,
	);
	return parts.join("");
}

describe("type-string dispatch master detection (2.1.197+)", () => {
	const idx = indexDefinitions(makeTypeDispatchBundle());

	// Guard the FIXTURE, not the extractor. Padding fixes today's flaw; this is
	// what stops the next author reintroducing it silently, because nothing else
	// in the block reveals which strategy answered (oleks/claudecode-linter#40).
	//
	// Neutralising the "plugin-json" type string disarms strategy 2 and nothing
	// else — strategy 1 keys on the kebab string, which stays untouched. So a
	// null here is positive proof that strategy 1 cannot reach this fixture's
	// `.safeParse(`, and therefore that every assertion below is strategy 2's
	// work. Black-box on purpose: pinning the winner by reading it out of the
	// locator would couple these tests to internals rewritten twice (#33, #39).
	it("is a fixture strategy 1 cannot answer, so the rest pin strategy 2", () => {
		const disarmed = makeTypeDispatchBundle().replace(
			'"plugin-json"',
			'"skill-md"',
		);
		expect(findMasterSchemaName(indexDefinitions(disarmed))).toBeNull();
	});

	it("falls back to the validator dispatch when kebab-case is not adjacent to safeParse", () => {
		expect(findMasterSchemaName(idx)).toBe("masterSchema");
	});

	it("still composes the full plugin schema", () => {
		const schema = buildPluginSchema(idx);
		const props = schema.properties as Record<string, object>;
		expect(Object.keys(props).sort()).toEqual([
			"description",
			"name",
			"version",
		]);
		expect(schema.required).toEqual(["name"]);
	});

	it("tolerates a single-quoted type string and a function-expression validator", () => {
		// Same dispatch shape, but the validator is bound as a function
		// expression and dispatched with a single-quoted type literal.
		const src =
			`var coreSchema=CH(()=>E.object({name:E.string().min(1)})),` +
			`masterSchema=CH(()=>E.object({...coreSchema().shape}));` +
			`var KWe=function(e,t){let a=masterSchema().safeParse(e);return a};` +
			pad() +
			`function lint(m){KWe(m,'plugin-json');` +
			`if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name))push("is not kebab-case")}`;
		expect(findMasterSchemaName(indexDefinitions(src))).toBe("masterSchema");
		// The same fixture guard, for this block's second fixture.
		expect(
			findMasterSchemaName(
				indexDefinitions(src.replace("'plugin-json'", "'skill-md'")),
			),
		).toBeNull();
	});
});

describe("numeric constraint guard", () => {
	// A `.max()` whose argument is an unresolved minified variable must NOT emit
	// a `maxItems: null` (NaN) keyword that Ajv later rejects — the constraint is
	// dropped instead.
	const idx = indexDefinitions(
		"var s=CH(()=>E.object({tags:E.array(E.string()).max(SOME_VAR).optional(),names:E.array(E.string()).max(5).optional()}))",
	);

	it("drops an array max with a non-literal bound but keeps a literal one", () => {
		const schema = evalZod(idx.defs.get("s")!, {
			index: idx,
			resolving: new Set(),
		});
		const props = schema.properties as Record<string, Record<string, unknown>>;
		expect(props.tags).not.toHaveProperty("maxItems");
		expect(props.names.maxItems).toBe(5);
	});
});
