/**
 * Unit tests for the code-split-bundle support in
 * `scripts/extract-plugin-schema.ts` (oleks/claudecode-linter#31).
 *
 * Claude Code 2.1.259 replaced the single-CJS-module bundle with a code-split
 * ESM one (~1,635 modules) that reaches Zod through bare imported bindings
 * instead of a namespace alias. These tests run against in-memory fragments
 * rather than a real binary, so they stay stable across releases.
 *
 * Two things are pinned here:
 *
 *  - the empty-index GUARD, which must turn a failed extraction into a failed
 *    run instead of a permissive, rule-disabling set of schemas; and
 *  - the resolution fixes that stop a 1,635-module corpus from silently
 *    resolving a symbol into the wrong module's code.
 */

import { describe, it, expect } from "vitest";
import {
	assertDefinitionsUsable,
	buildCorpus,
	collectZodFactories,
	evalZod,
	indexDefinitions,
	mapZodFactories,
	normalizeZodModule,
	splitUnionBranches,
	CANONICAL_ZOD_ALIAS,
} from "../../scripts/extract-plugin-schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A stand-in for the bundle's Zod runtime chunk. `collectZodFactories` only
 * treats a module as a Zod chunk when it declares at least ZOD_CHUNK_CLASS_FLOOR
 * (10) `X=Y("ZodFoo"` class symbols, so declare a full set.
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
		// Tagged factories: the def literal carries the Zod type tag.
		`function c(e,r){let t={type:"object",shape:e??{}};return new Zc(t)}`,
		`function ee(e,r){let t={type:"enum",entries:e};return new Zc(t)}`,
		`function Ge(e){let t={type:"union",options:e};return new Zc(t)}`,
		`function ui(e,r){let t={type:"union",discriminator:e,options:r};return new Zc(t)}`,
		// Untagged, delegating factories: resolved through the class symbol.
		`function i(e){return Sn(Sym0,e)}`,
		`function A(e){return Sn(Sym1,e)}`,
		`function T(e){return Sn(Sym4,e)}`,
		`export{c,ee,Ge,ui,i,A,T};`,
	].join("");
}

/** A consumer module in 2.1.259 style: bare imported Zod bindings. */
function consumerModule(): string {
	return [
		`import{c,i,A,T}from"/$bunfs/root/chunk-abc123.js";`,
		`var demoSchema=m(()=>c({name:i(),count:A(),tags:T(i())}));`,
		`export{demoSchema};`,
	].join("");
}

// ---------------------------------------------------------------------------
// The guard — the half of #31 that turns a failure into a failure
// ---------------------------------------------------------------------------

describe("assertDefinitionsUsable — empty-index guard", () => {
	it("throws when the definition index came back empty", () => {
		const index = indexDefinitions("");
		expect(index.defs.size).toBe(0);
		expect(() => assertDefinitionsUsable(index)).toThrow(
			/Indexed 0 Zod definitions/,
		);
	});

	it("names the floor and the refusal, so the failure is actionable", () => {
		expect(() => assertDefinitionsUsable(indexDefinitions(""))).toThrow(
			/Refusing to write schemas/,
		);
	});

	it("throws on a corpus that parses but indexes almost nothing", () => {
		// A bundle whose Zod call form changed: shaped like the real thing, but
		// the walker recognises only a couple of definitions. This is the case
		// that previously produced permissive `{}` schemas and exit 0.
		const thin = `var a=CH(()=>E.object({x:E.string()})),b=CH(()=>E.object({y:E.string()}));`;
		const index = indexDefinitions(thin);
		expect(index.defs.size).toBeGreaterThan(0);
		expect(index.defs.size).toBeLessThan(50);
		expect(() => assertDefinitionsUsable(index)).toThrow(/below the floor/);
	});

	it("passes a healthy index", () => {
		const defs = Array.from(
			{ length: 60 },
			(_, n) => `s${n}=CH(()=>E.object({f:E.string()}))`,
		).join(",");
		const index = indexDefinitions(`var ${defs};`);
		expect(index.defs.size).toBeGreaterThanOrEqual(50);
		expect(() => assertDefinitionsUsable(index)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Normalising a code-split bundle
// ---------------------------------------------------------------------------

describe("code-split normalisation", () => {
	it("maps a chunk's minified factories to their Zod methods", () => {
		const factories = mapZodFactories(zodChunk());
		expect(factories.get("c")).toBe("object");
		expect(factories.get("Ge")).toBe("union");
		expect(factories.get("ui")).toBe("discriminatedUnion");
		// Untagged factories resolve through the unminified class-name string.
		expect(factories.get("i")).toBe("string");
		expect(factories.get("A")).toBe("number");
	});

	it("only harvests factories from modules that look like Zod chunks", () => {
		// A module with a couple of Zod class strings is not the runtime chunk.
		const notAChunk = `var q=pn("ZodString","x");function c(e){let t={type:"object"};return t}`;
		expect(collectZodFactories([notAChunk]).size).toBe(0);
	});

	it("rewrites bare imported bindings to the canonical alias", () => {
		const factories = collectZodFactories([zodChunk()]);
		const out = normalizeZodModule(consumerModule(), factories);
		expect(out).not.toBeNull();
		expect(out).toContain(`${CANONICAL_ZOD_ALIAS}.object(`);
		expect(out).toContain(`${CANONICAL_ZOD_ALIAS}.string(`);
	});

	it("drops a module with no meaningful Zod usage", () => {
		const factories = collectZodFactories([zodChunk()]);
		const noise = `import{i}from"/$bunfs/root/chunk-abc123.js";var q=1;export{q};`;
		expect(normalizeZodModule(noise, factories)).toBeNull();
	});

	it("makes a code-split corpus indexable end to end", () => {
		const corpus = buildCorpus([zodChunk(), consumerModule()]);
		const index = indexDefinitions(corpus);
		expect(index.zodAlias).toBe(CANONICAL_ZOD_ALIAS);
		const def = index.defs.get("demoSchema");
		expect(def).toBeDefined();
		const schema = evalZod(def as string, { index, resolving: new Set() });
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties ?? {})).toEqual([
			"name",
			"count",
			"tags",
		]);
	});
});

// ---------------------------------------------------------------------------
// Union branch splitting
// ---------------------------------------------------------------------------

describe("splitUnionBranches", () => {
	it("splits a plain branch list", () => {
		expect(splitUnionBranches("A(),B()")).toEqual(["A()", "B()"]);
	});

	it("flattens a spread of an array literal", () => {
		// 2.1.259 writes the per-hook union as `[...[e,n,o,s,r]]`.
		expect(splitUnionBranches("...[e,n,o,s,r]")).toEqual([
			"e",
			"n",
			"o",
			"s",
			"r",
		]);
	});

	it("leaves a spread of an opaque identifier alone rather than guessing", () => {
		expect(splitUnionBranches("...rest")).toEqual(["...rest"]);
	});

	it("keeps nested array literals inside a branch intact", () => {
		expect(splitUnionBranches("A([1,2]),B()")).toEqual(["A([1,2])", "B()"]);
	});
});

// ---------------------------------------------------------------------------
// Optionality through wrapper combinators
// ---------------------------------------------------------------------------

describe("optionality through wrapper calls", () => {
	function requiredOf(objectExpr: string): string[] {
		const src = `var W=CH(()=>${objectExpr});`;
		const index = indexDefinitions(src);
		const schema = evalZod(index.defs.get("W") as string, {
			index,
			resolving: new Set(),
		});
		return (schema.required as string[]) ?? [];
	}

	it("treats a plain field as required", () => {
		expect(requiredOf("E.object({a:E.string()})")).toEqual(["a"]);
	});

	it("sees optionality carried in a combinator argument", () => {
		// `metadata:E.pipe(fn, E.record(...).optional())` — plugin.json.
		expect(
			requiredOf("E.object({a:E.pipe((x)=>x,E.string().optional())})"),
		).toEqual([]);
	});

	it("sees optionality through an unknown local wrapper", () => {
		// `policyHelper:s(Mt().optional(),(r)=>…)` — settings.json.
		expect(
			requiredOf("E.object({a:pp(E.string().optional(),(r)=>r)})"),
		).toEqual([]);
	});

	it("does not let a nested object's optional field leak upward", () => {
		// The guard that keeps the combinator rule from making everything
		// optional: `a` is an object whose OWN field is optional, so `a` itself
		// is still required.
		expect(
			requiredOf("E.object({a:E.object({inner:E.string().optional()})})"),
		).toEqual(["a"]);
	});
});

// ---------------------------------------------------------------------------
// Cross-module symbol shadowing
// ---------------------------------------------------------------------------

describe("cross-module symbol shadowing", () => {
	it("resolves an alias even when another module binds the name to an array", () => {
		// 2.1.259: an unrelated module's `u_=["stylesheet",…]` vetoed the skill
		// module's `u_=aJe`, leaving skill/agent/command `name` untyped.
		const src = [
			`var u_=["stylesheet","stale-banner"];`,
			`var aJe=()=>E.union([E.string(),E.number()]),u_=aJe;`,
			`var W=CH(()=>E.object({name:u_()}));`,
		].join("");
		const index = indexDefinitions(src);
		const schema = evalZod(index.defs.get("W") as string, {
			index,
			resolving: new Set(),
		});
		const name = (schema.properties as Record<string, { anyOf?: unknown[] }>)
			.name;
		expect(name.anyOf).toBeDefined();
		expect(name.anyOf).toHaveLength(2);
	});

	it("picks the same-named helper that actually supplies the destructured keys", () => {
		// Eleven `function Fl(` exist in 2.1.259 and the hook-schema bundle is
		// not the first. Taking the first dropped the whole per-hook union.
		const src = [
			// A same-named helper that does not return an object at all.
			`function F(e){return String(e)}`,
			// A same-named helper that DOES return a schema bundle, but not the
			// one asked for. Without matching on the destructured keys this one
			// is taken and the union comes out wrong.
			`function F(){let Z=E.object({type:E.literal("z"),z:E.string()});return{KZ:Z}}`,
			// The real one, third.
			`function F(){let A=E.object({type:E.literal("a"),x:E.string()}),`,
			`B=E.object({type:E.literal("b"),y:E.string()});return{KA:A,KB:B}}`,
			`var U=CH(()=>{let{KA:p,KB:q}=F();return E.discriminatedUnion("type",[...[p,q]])});`,
		].join("");
		const index = indexDefinitions(src);
		const schema = evalZod(index.defs.get("U") as string, {
			index,
			resolving: new Set(),
		});
		expect(schema.oneOf).toHaveLength(2);
		const types = (schema.oneOf as Array<{ properties: Record<string, { const?: string }> }>).map(
			(b) => b.properties.type.const,
		);
		expect(types).toEqual(["a", "b"]);
	});
});
