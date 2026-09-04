/**
 * Module-scoped symbol resolution and the per-schema drift gate
 * (oleks/claudecode-linter#33).
 *
 * `extract-plugin-schema-codesplit.test.ts` pins four SYMPTOMS of one
 * mechanism, each found and fixed individually in #31: the corpus is a
 * concatenation of ~1,635 code-split modules, minified names are module-scoped,
 * and the definition index kept only the first binding of each name. Fixing the
 * symptoms leaves every symbol no test happens to exercise still able to
 * resolve into an unrelated module's code — silently, with the run exiting 0.
 *
 * These tests pin the mechanism instead: a reference resolves to its own
 * module's binding when one exists, a cross-module reference still resolves,
 * and the genuinely ambiguous case is left alone rather than guessed at.
 *
 * They run against in-memory module fragments, not a real binary, so they stay
 * stable across Claude Code releases.
 */

import { describe, it, expect } from "vitest";
import {
	buildCorpus,
	buildCorpusWithRanges,
	evalZod,
	indexDefinitions,
	missingSchemaIsFatal,
	moduleOfOffset,
	resolveDefSite,
	schemaDriftVerdict,
	schemaPropertyPaths,
} from "../../scripts/extract-plugin-schema.js";
import type {
	DefinitionIndex,
	JSONSchema,
} from "../../scripts/extract-plugin-schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A stand-in for the bundle's Zod runtime chunk. `collectZodFactories` only
 * treats a module as a Zod chunk when it declares at least 10 `X=Y("ZodFoo"`
 * class symbols, so declare a full set.
 */
function zodChunk(): string {
	const classes = [
		"ZodString",
		"ZodNumber",
		"ZodBoolean",
		"ZodNull",
		"ZodArray",
		"ZodObject",
		"ZodUnion",
		"ZodEnum",
		"ZodRecord",
		"ZodLiteral",
		"ZodOptional",
	]
		.map((c, n) => `Sym${n}=pn("${c}","x")`)
		.join(",");
	return [
		`var ${classes};`,
		`function c(e,r){let t={type:"object",shape:e??{}};return new Zc(t)}`,
		`function ee(e,r){let t={type:"enum",entries:e};return new Zc(t)}`,
		`function Ge(e){let t={type:"union",options:e};return new Zc(t)}`,
		`function i(e){return Sn(Sym0,e)}`,
		`function A(e){return Sn(Sym1,e)}`,
		`function T(e){return Sn(Sym4,e)}`,
		`export{c,ee,Ge,i,A,T};`,
	].join("");
}

/**
 * A module in 2.1.259 style that binds the shared name `S` to a schema whose
 * one field is named after `tag`, and exposes a module-unique entry point that
 * refers to it.
 *
 * Two of these are the collision this issue is about: `S` means something
 * different in each module, while `Top<tag>` is declared in one module only.
 */
function shadowingModule(tag: string): string {
	return [
		`import{c,i,A}from"/$bunfs/root/chunk-abc123.js";`,
		`var S=m(()=>c({${tag}:i()}));`,
		`var Top${tag}=m(()=>c({inner:S(),count:A()}));`,
		`export{S,Top${tag}};`,
	].join("");
}

/** Index a set of raw modules through the same path the extractor uses. */
function indexModules(modules: string[]): DefinitionIndex {
	const corpus = buildCorpusWithRanges([zodChunk(), ...modules]);
	return indexDefinitions(corpus.source, corpus.moduleRanges);
}

/**
 * Evaluate a top-level symbol the way every builder does: resolve it to a
 * binding, then evaluate that binding *in the module it was declared in*.
 */
function evalSymbol(index: DefinitionIndex, name: string): JSONSchema {
	const site = resolveDefSite(index, name);
	expect(site, `no binding for ${name}`).not.toBeNull();
	const found = site as { module: number; value: string };
	return evalZod(found.value, {
		index,
		resolving: new Set(),
		module: found.module,
	});
}

function propNames(schema: JSONSchema | undefined): string[] {
	return Object.keys((schema?.properties as object) ?? {});
}

function prop(schema: JSONSchema, key: string): JSONSchema {
	return (schema.properties as Record<string, JSONSchema>)[key];
}

// ---------------------------------------------------------------------------
// Module ranges — the boundaries the concatenation used to throw away
// ---------------------------------------------------------------------------

describe("module ranges", () => {
	it("tiles the corpus exactly, so every offset maps to its own module", () => {
		const parts = [
			zodChunk(),
			shadowingModule("alpha"),
			shadowingModule("beta"),
		];
		const { source, moduleRanges } = buildCorpusWithRanges(parts);
		expect(moduleRanges.length).toBeGreaterThan(1);
		// Ranges are ordered and separated by exactly the one join character.
		for (let i = 1; i < moduleRanges.length; i++) {
			expect(moduleRanges[i].start).toBe(moduleRanges[i - 1].end + 1);
		}
		expect(moduleRanges[0].start).toBe(0);
		expect(moduleRanges[moduleRanges.length - 1].end).toBe(source.length);
		// Every module's own text is addressable at its range.
		for (const range of moduleRanges) {
			expect(source.slice(range.start, range.end)).not.toContain("\n");
		}
	});

	it("agrees with buildCorpus on the corpus text", () => {
		const parts = [zodChunk(), shadowingModule("alpha")];
		expect(buildCorpusWithRanges(parts).source).toBe(buildCorpus(parts));
	});

	it("reports -1 for an offset in no module, never module 0", () => {
		// -1 is the "unknown module" signal every resolution path reads as
		// "fall back to corpus-wide". Returning 0 would silently claim every
		// unknown reference belongs to the first module.
		const { moduleRanges } = buildCorpusWithRanges([
			shadowingModule("alpha"),
			shadowingModule("beta"),
		]);
		expect(moduleOfOffset(moduleRanges, -5)).toBe(-1);
		expect(moduleOfOffset(moduleRanges, 1e9)).toBe(-1);
		// The separator between two modules belongs to neither.
		expect(moduleOfOffset(moduleRanges, moduleRanges[0].end)).toBe(-1);
		expect(moduleOfOffset([], 0)).toBe(-1);
	});

	it("finds the right module for an offset anywhere in the corpus", () => {
		const { moduleRanges } = buildCorpusWithRanges([
			shadowingModule("alpha"),
			shadowingModule("beta"),
			shadowingModule("gamma"),
		]);
		moduleRanges.forEach((range, i) => {
			expect(moduleOfOffset(moduleRanges, range.start)).toBe(i);
			expect(moduleOfOffset(moduleRanges, range.end - 1)).toBe(i);
		});
	});
});

// ---------------------------------------------------------------------------
// The mechanism
// ---------------------------------------------------------------------------

describe("module-scoped symbol resolution", () => {
	it("resolves a shared name to EACH module's own binding", () => {
		// The acceptance test for #33. Two modules bind `S` to different
		// schemas. Before the fix both entry points resolved `S()` through
		// whichever module the concatenation happened to put first, so
		// `Topbeta.inner` came out holding `alpha`.
		const index = indexModules([
			shadowingModule("alpha"),
			shadowingModule("beta"),
		]);
		// The premise: `S` really is bound in two different modules.
		const sites = index.defSites.get("S");
		expect(sites).toBeDefined();
		expect(sites).toHaveLength(2);
		expect(sites?.[0].module).not.toBe(sites?.[1].module);

		expect(propNames(prop(evalSymbol(index, "Topalpha"), "inner"))).toEqual([
			"alpha",
		]);
		expect(propNames(prop(evalSymbol(index, "Topbeta"), "inner"))).toEqual([
			"beta",
		]);
	});

	it("holds for a name bound in many modules, not just two", () => {
		const tags = ["alpha", "beta", "gamma", "delta", "epsilon"];
		const index = indexModules(tags.map(shadowingModule));
		expect(index.defSites.get("S")).toHaveLength(tags.length);
		for (const tag of tags) {
			expect(propNames(prop(evalSymbol(index, `Top${tag}`), "inner"))).toEqual([
				tag,
			]);
		}
	});

	it("still resolves a reference whose definition lives in another module", () => {
		// Own-module-first must not break the ordinary case: on 2.1.259 the
		// `"plugin-json"` dispatch that names the master schema and the master
		// schema's own declaration sit in different modules. A name bound
		// exactly once has nothing to be ambiguous about and must resolve.
		const definer = [
			`import{c,i}from"/$bunfs/root/chunk-abc123.js";`,
			`var Shared=m(()=>c({only:i(),here:i()}));`,
			`export{Shared};`,
		].join("");
		const consumer = [
			`import{c,i,A}from"/$bunfs/root/chunk-abc123.js";`,
			`var Uses=m(()=>c({inner:Shared(),n:A(),s:i()}));`,
			`export{Uses};`,
		].join("");
		const index = indexModules([definer, consumer]);
		expect(index.defSites.get("Shared")).toHaveLength(1);
		expect(propNames(prop(evalSymbol(index, "Uses"), "inner"))).toEqual([
			"only",
			"here",
		]);
	});

	it("keeps the first binding when a name is ambiguous and unbound locally", () => {
		// The case the module boundaries genuinely cannot decide: the referring
		// module has no binding of its own and the corpus has several. Nothing
		// in the corpus says which is meant, so this stays the pre-existing
		// behaviour rather than becoming a coin flip dressed up as a fix.
		const consumer = [
			`import{c,i,A}from"/$bunfs/root/chunk-abc123.js";`,
			`var Borrows=m(()=>c({inner:S(),n:A(),s:i()}));`,
			`export{Borrows};`,
		].join("");
		const index = indexModules([
			shadowingModule("alpha"),
			shadowingModule("beta"),
			consumer,
		]);
		expect(propNames(prop(evalSymbol(index, "Borrows"), "inner"))).toEqual([
			"alpha",
		]);
	});

	it("prefers the same-named helper function declared in its own module", () => {
		// `function <name>(` collides far harder than schema names do: 5,312 of
		// 15,225 function names in 2.1.259 are declared in more than one module.
		// Matching on the destructured keys — the #31 fix — cannot separate two
		// modules whose helpers return the SAME keys. Only the module can.
		const mod = (tag: string) =>
			[
				`import{c,i,A}from"/$bunfs/root/chunk-abc123.js";`,
				`function F(){let K=c({${tag}:i()});return{Bundle:K}}`,
				// A plain lazy factory alongside the block-body one: the lazy
				// wrapper is detected from `<name>(()=><alias>.`, and a module
				// holding only block bodies would not name it.
				`var Plain${tag}=m(()=>c({p:i()}));`,
				`var Use${tag}=m(()=>{let{Bundle:b}=F();return c({inner:b,n:A()})});`,
				`export{Plain${tag},Use${tag}};`,
			].join("");
		const index = indexModules([mod("alpha"), mod("beta")]);
		expect(propNames(prop(evalSymbol(index, "Usealpha"), "inner"))).toEqual([
			"alpha",
		]);
		expect(propNames(prop(evalSymbol(index, "Usebeta"), "inner"))).toEqual([
			"beta",
		]);
	});

	it("scopes array bindings the same way", () => {
		// `<alias>.enum(<name>)` reads the array index, which was
		// first-binding-wins for exactly the same reason `defs` was.
		const mod = (tag: string) =>
			[
				`import{c,ee,i,A}from"/$bunfs/root/chunk-abc123.js";`,
				`var VALS=["${tag}-one","${tag}-two"];`,
				`var Lit${tag}=m(()=>c({e:ee(VALS),n:A(),s:i()}));`,
				`export{Lit${tag}};`,
			].join("");
		const index = indexModules([mod("alpha"), mod("beta")]);
		expect(index.arraySites.get("VALS")).toHaveLength(2);
		expect(prop(evalSymbol(index, "Litbeta"), "e").enum).toEqual([
			"beta-one",
			"beta-two",
		]);
		expect(prop(evalSymbol(index, "Litalpha"), "e").enum).toEqual([
			"alpha-one",
			"alpha-two",
		]);
	});

	it("falls back to corpus-wide behaviour when no ranges are supplied", () => {
		// Every pre-existing caller passes a bare string. With no module ranges
		// every binding is module -1, and resolution is exactly what it was.
		const src = `var S=CH(()=>E.object({a:E.string()})),W=CH(()=>E.object({inner:S()}));`;
		const index = indexDefinitions(src);
		expect(index.moduleRanges).toEqual([]);
		expect(index.defSites.get("S")?.[0].module).toBe(-1);
		expect(propNames(prop(evalSymbol(index, "W"), "inner"))).toEqual(["a"]);
	});

	it("keeps defSites[0] equal to the first-wins binding in defs", () => {
		// The corpus-wide fallback reads defSites[0]. It must be bit-for-bit
		// what `defs` holds, or the fallback quietly changes behaviour on every
		// name that has more than one binding — which is most of the point of
		// the fix being invisible in contracts/ output.
		const index = indexModules([
			shadowingModule("alpha"),
			shadowingModule("beta"),
			shadowingModule("gamma"),
		]);
		expect(index.defs.size).toBeGreaterThan(0);
		for (const [name, expr] of index.defs) {
			expect(index.defSites.get(name)?.[0].value, name).toBe(expr);
		}
	});

	it("returns null for a name with no binding at all", () => {
		const index = indexModules([shadowingModule("alpha")]);
		expect(resolveDefSite(index, "NotABinding")).toBeNull();
		expect(resolveDefSite(index, "NotABinding", 0)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Per-schema drift gate
// ---------------------------------------------------------------------------

describe("schemaPropertyPaths — the drift gate's denominator", () => {
	it("counts nested properties, not just top-level ones", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				hooks: {
					type: "object",
					additionalProperties: {
						type: "array",
						items: { type: "object", properties: { matcher: {} } },
					},
				},
			},
		};
		expect([...schemaPropertyPaths(schema)].sort()).toEqual([
			"/hooks",
			"/hooks/additionalProperties/items/matcher",
		]);
	});

	it("gives a record-rooted schema a non-zero denominator", () => {
		// `.lsp.json` has ZERO top-level properties, so the old top-level-field
		// rule could never fire on it however much of it vanished.
		const lspLike: JSONSchema = {
			type: "object",
			additionalProperties: {
				type: "object",
				properties: { command: {}, args: {} },
			},
		};
		expect(Object.keys((lspLike.properties as object) ?? {})).toHaveLength(0);
		expect(schemaPropertyPaths(lspLike).size).toBe(2);
	});

	it("gives an array-rooted schema a non-zero denominator", () => {
		// Same for `monitors.json`, an array at the root.
		const monitorsLike: JSONSchema = {
			type: "array",
			items: { type: "object", properties: { name: {}, command: {} } },
		};
		expect(schemaPropertyPaths(monitorsLike).size).toBe(2);
	});

	it("walks union branches, where a collapsed subtree hides", () => {
		const unionLike: JSONSchema = {
			type: "object",
			properties: {
				hook: {
					oneOf: [
						{ type: "object", properties: { command: {} } },
						{ type: "object", properties: { prompt: {} } },
					],
				},
			},
		};
		expect([...schemaPropertyPaths(unionLike)].sort()).toEqual([
			"/hook",
			"/hook/oneOf[0]/command",
			"/hook/oneOf[1]/prompt",
		]);
	});

	it("returns nothing for a schema degraded to a permissive {}", () => {
		// The shape an unresolved symbol leaves behind — what the gate has to
		// read as a total loss rather than shrug at.
		expect(schemaPropertyPaths({}).size).toBe(0);
		expect(schemaPropertyPaths(null).size).toBe(0);
		expect(schemaPropertyPaths("not a schema").size).toBe(0);
	});

	it("separates two schemas that differ only deep inside", () => {
		// A 30% rule is only meaningful if the paths it counts actually move
		// when a subtree collapses.
		const full: JSONSchema = {
			type: "object",
			properties: {
				a: { type: "object", properties: { x: {}, y: {}, z: {} } },
				b: {},
			},
		};
		const collapsed: JSONSchema = {
			type: "object",
			properties: { a: {}, b: {} },
		};
		const before = schemaPropertyPaths(full);
		const after = schemaPropertyPaths(collapsed);
		expect(before.size).toBe(5);
		expect(after.size).toBe(2);
		const lost = [...before].filter((p) => !after.has(p));
		expect(lost.length / before.size).toBeGreaterThan(0.3);
	});
});

// ---------------------------------------------------------------------------
// The gate's decision — the half that must FAIL CLOSED
// ---------------------------------------------------------------------------

describe("schemaDriftVerdict", () => {
	const objectOf = (...names: string[]): JSONSchema => ({
		type: "object",
		properties: Object.fromEntries(names.map((n) => [n, {}])),
	});

	it("passes an unchanged schema", () => {
		const v = schemaDriftVerdict(objectOf("a", "b", "c"), objectOf("a", "b", "c"));
		expect(v.lost).toEqual([]);
		expect(v.gained).toEqual([]);
		expect(v.fatal).toBe(false);
	});

	it("reports gains without failing", () => {
		const v = schemaDriftVerdict(objectOf("a"), objectOf("a", "b"));
		expect(v.gained).toEqual(["/b"]);
		expect(v.fatal).toBe(false);
	});

	it("tolerates a small loss as upstream churn", () => {
		// 1 of 10 = 10%. A field removed between Claude Code releases is normal
		// and must not redden the run.
		const prev = objectOf(..."abcdefghij".split(""));
		const now = objectOf(..."abcdefghi".split(""));
		const v = schemaDriftVerdict(prev, now);
		expect(v.lost).toEqual(["/j"]);
		expect(v.dropRate).toBeCloseTo(0.1);
		expect(v.fatal).toBe(false);
	});

	it("fails a loss past the limit", () => {
		// 4 of 10 = 40%. Extraction breakage is characteristically wholesale,
		// which is what separates it from churn.
		const prev = objectOf(..."abcdefghij".split(""));
		const now = objectOf(..."abcdef".split(""));
		const v = schemaDriftVerdict(prev, now);
		expect(v.lost).toHaveLength(4);
		expect(v.fatal).toBe(true);
	});

	it("fails the 83% frontmatter collapse that used to pass silently", () => {
		// Measured during #31: the skill/agent/command frontmatter schemas went
		// 42 -> 7, 20 -> 7 and 13 -> 7 fields with nothing failing, because the
		// gate was attached to plugin.schema.json alone.
		const prev = objectOf(
			...Array.from({ length: 42 }, (_, i) => `f${i}`),
		);
		const now = objectOf(...Array.from({ length: 7 }, (_, i) => `f${i}`));
		const v = schemaDriftVerdict(prev, now);
		expect(v.prevCount).toBe(42);
		expect(v.lost).toHaveLength(35);
		expect(v.dropRate).toBeCloseTo(35 / 42);
		expect(v.fatal).toBe(true);
	});

	it("fires on a record-rooted schema, which a top-level rule could not", () => {
		// `.lsp.json` — zero top-level properties either side, so the old rule
		// had a zero denominator and could never fail however much was lost.
		const prev: JSONSchema = {
			type: "object",
			additionalProperties: {
				type: "object",
				properties: { command: {}, args: {}, env: {}, extensions: {} },
			},
		};
		const now: JSONSchema = { type: "object", additionalProperties: {} };
		expect(Object.keys((prev.properties as object) ?? {})).toHaveLength(0);
		const v = schemaDriftVerdict(prev, now);
		expect(v.prevCount).toBe(4);
		expect(v.dropRate).toBe(1);
		expect(v.fatal).toBe(true);
	});

	it("fires on an array-rooted schema too", () => {
		const prev: JSONSchema = {
			type: "array",
			items: { type: "object", properties: { name: {}, cmd: {}, when: {} } },
		};
		const now: JSONSchema = { type: "array", items: {} };
		const v = schemaDriftVerdict(prev, now);
		expect(v.prevCount).toBe(3);
		expect(v.fatal).toBe(true);
	});

	it("gives no verdict when there is no previous extraction", () => {
		// First run. Nothing to compare against is not the same as "fine", and
		// must not be reported as a loss.
		const v = schemaDriftVerdict(null, objectOf("a"));
		expect(v.prevCount).toBe(0);
		expect(v.lost).toEqual([]);
		expect(v.fatal).toBe(false);
	});

	it("gives no verdict when the previous extraction was already empty", () => {
		// A zero denominator cannot yield a rate. Reported as no verdict rather
		// than as a silent pass with a NaN behind it.
		const v = schemaDriftVerdict({}, objectOf("a"));
		expect(v.prevCount).toBe(0);
		expect(v.dropRate).toBe(0);
		expect(v.fatal).toBe(false);
	});

	it("honours a caller-supplied limit", () => {
		const prev = objectOf("a", "b", "c", "d");
		const now = objectOf("a", "b", "c");
		expect(schemaDriftVerdict(prev, now, 0.3).fatal).toBe(false);
		expect(schemaDriftVerdict(prev, now, 0.1).fatal).toBe(true);
	});

	it("counts a total collapse to {} as a total loss", () => {
		// The exact shape an unresolved symbol leaves behind.
		const v = schemaDriftVerdict(objectOf("a", "b", "c"), {});
		expect(v.dropRate).toBe(1);
		expect(v.fatal).toBe(true);
	});
});

describe("missingSchemaIsFatal", () => {
	it("is fatal when a schema that previously extracted stops building", () => {
		// Losing 100% of a schema cannot be less serious than losing 31% of it.
		// This used to print a yellow warning, leave the stale file in place,
		// and exit 0.
		expect(
			missingSchemaIsFatal({
				type: "object",
				properties: { a: {}, b: {} },
			}),
		).toBe(true);
	});

	it("is not fatal when nothing was ever extracted", () => {
		expect(missingSchemaIsFatal(null)).toBe(false);
	});

	it("is not fatal when the previous extraction carried no paths", () => {
		// Nothing was lost, because there was nothing there.
		expect(missingSchemaIsFatal({})).toBe(false);
	});
});
