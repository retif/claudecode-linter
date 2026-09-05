/**
 * Alias factory bindings the definition index must recognise
 * (oleks/claudecode-linter#43).
 *
 * `extract-plugin-schema-local-factory-shapes.test.ts` (#41) pins that a
 * local factory declared as a bare arrow or a function statement is visible
 * to its own module. This file pins the third shape: a bare ALIAS of such a
 * factory — `BU=z4e`, no arrow, no `function`, no Zod call at all.
 *
 * The alias pass in `indexDefinitions` already recognised the shape (`LW=z36`
 * has been handled since the frontmatter schemas were added). What broke on
 * 2.1.261 was the pass's veto: it skipped any alias whose NAME was already in
 * `defs` — a corpus-wide check. The frontmatter module declares
 *
 *   var z4e=()=>Ne([s(),w(),P(),Fp()]),__=z4e,BU=z4e
 *   …"disable-model-invocation":BU().optional().describe("If true, the model
 *   cannot invoke this via the Skill tool; …")
 *
 * (the string/number/boolean/null union) while an unrelated module binds
 *
 *   BU=m(()=>c({name:s(),permission_policy:X([…]).optional(),
 *   org_max_permission:X([…]).optional()}))
 *
 * — the MCP per-tool permission-policy object. The object was indexed first,
 * `defs.has("BU")` was true, the alias was skipped, and the frontmatter module
 * had no binding of `BU` at all. As in #41, that miss is not neutral:
 * `resolveDefSite` fell through to the other module's object, and
 * `disable-model-invocation`, `user-invocable`, `background`, `fallback` and
 * `observeSubagents` were all published as `{name, permission_policy,
 * org_max_permission}` — 12/6/6 property paths on skill/agent/command
 * frontmatter that exist nowhere in the upstream source.
 *
 * Two rules are pinned here:
 *
 *  1. only a binding in the alias's OWN module vetoes it;
 *  2. an alias resolves only to a factory bound in its own module — a
 *     cross-module target is a guess, and a guess is how #41 and #43 both
 *     fabricated paths. An alias whose target is not visible locally stays
 *     unindexed and degrades to `{}` as before.
 *
 * These tests run against in-memory module fragments, not a real binary, so
 * they stay stable across Claude Code releases.
 */

import { describe, it, expect } from "vitest";
import {
	buildCorpusWithRanges,
	evalZod,
	indexDefinitions,
	resolveDefSite,
} from "../../scripts/extract-plugin-schema.js";
import type {
	DefinitionIndex,
	JSONSchema,
} from "../../scripts/extract-plugin-schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A stand-in for the bundle's Zod runtime chunk — same construction as the
 * #41 fixture. `collectZodFactories` only treats a module as a Zod chunk when
 * it declares at least 10 `X=Y("ZodFoo"` class symbols.
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
		`function P(e){return Sn(Sym2,e)}`,
		`export{c,ee,Ge,i,A,P};`,
	].join("");
}

/**
 * The FOREIGN module: binds `BU` to an OBJECT factory in the lazy-wrapper
 * shape the index has always recognised, and uses it itself. Placed first in
 * the corpus so `defSites.get("BU")[0]` is this module — i.e. so a miss in the
 * frontmatter module lands here, exactly as `disable-model-invocation` landed
 * on the permission-policy object.
 */
function foreignModule(): string {
	return [
		`import{c,i}from"/$bunfs/root/chunk-abc123.js";`,
		`var BU=m(()=>c({name:i(),permission_policy:i().optional(),org_max_permission:i().optional()}));`,
		`var TopForeign=m(()=>c({tool:BU()}));`,
		`export{BU,TopForeign};`,
	].join("");
}

/**
 * The FRONTMATTER module: declares the union factory once and aliases it
 * twice, then types its fields through the aliases — the 2.1.261 shape.
 */
function frontmatterModule(): string {
	return [
		`import{c,Ge,i,A,P}from"/$bunfs/root/chunk-abc123.js";`,
		`var z4e=()=>Ge([i(),A(),P()]),__=z4e,BU=z4e;`,
		`var TopFrontmatter=m(()=>c({` +
			`"disable-model-invocation":BU().optional().describe("If true, the model cannot invoke this"),` +
			`"user-invocable":__().optional().describe("Whether users can invoke this")` +
			`}));`,
		`export{z4e,__,BU,TopFrontmatter};`,
	].join("");
}

/** Index a set of raw modules through the same path the extractor uses. */
function indexModules(modules: string[]): DefinitionIndex {
	const corpus = buildCorpusWithRanges([zodChunk(), ...modules]);
	return indexDefinitions(corpus.source, corpus.moduleRanges);
}

/** Evaluate a top-level symbol in the module it was declared in. */
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

function prop(schema: JSONSchema, key: string): JSONSchema {
	return (schema.properties as Record<string, JSONSchema>)[key];
}

const UNION = [{ type: "string" }, { type: "number" }, { type: "boolean" }];

// ---------------------------------------------------------------------------
// The blind spot
// ---------------------------------------------------------------------------

describe("alias factory bindings the index must recognise", () => {
	it("indexes `BU=z4e` even when another module already binds `BU` to a factory", () => {
		// Before #43 the alias pass vetoed on `defs.has("BU")`, which the
		// foreign module's object factory had already made true.
		const index = indexModules([foreignModule(), frontmatterModule()]);
		const sites = index.defSites.get("BU");
		expect(sites, "BU must be bound in BOTH modules").toHaveLength(2);
		// The frontmatter module's binding is the alias, recorded as a call to
		// the factory it aliases.
		expect(sites?.[1].value).toBe("z4e()");
	});

	it("indexes the sibling alias `__=z4e` in the same declaration", () => {
		const index = indexModules([foreignModule(), frontmatterModule()]);
		expect(index.defs.get("__")).toBe("z4e()");
	});
});

// ---------------------------------------------------------------------------
// The consequence — what the vetoed alias actually produced
// ---------------------------------------------------------------------------

describe("a vetoed alias fabricates a foreign schema", () => {
	it("types the frontmatter fields as the union, not the permission-policy object", () => {
		// The acceptance test for #43. Before the fix both fields came out as
		// `{name, permission_policy, org_max_permission}`.
		const index = indexModules([foreignModule(), frontmatterModule()]);
		const top = evalSymbol(index, "TopFrontmatter");

		expect(prop(top, "disable-model-invocation")).toEqual({
			anyOf: UNION,
			description: "If true, the model cannot invoke this",
		});
		expect(prop(top, "user-invocable")).toEqual({
			anyOf: UNION,
			description: "Whether users can invoke this",
		});
		for (const key of ["disable-model-invocation", "user-invocable"]) {
			expect(prop(top, key).properties, `${key} must not be an object`)
				.toBeUndefined();
		}
	});

	it("still resolves the FOREIGN module's own `BU` to its own object", () => {
		// The other half, and the reason this is a fix rather than a mute
		// button: the module that genuinely binds `BU` to the permission-policy
		// object must keep getting it.
		const index = indexModules([foreignModule(), frontmatterModule()]);
		const top = evalSymbol(index, "TopForeign");
		expect(Object.keys(prop(top, "tool").properties as object)).toEqual([
			"name",
			"permission_policy",
			"org_max_permission",
		]);
	});

	it("is independent of module order", () => {
		// The veto used to depend on which module the concatenation put first.
		const index = indexModules([frontmatterModule(), foreignModule()]);
		const fm = evalSymbol(index, "TopFrontmatter");
		expect(prop(fm, "disable-model-invocation").anyOf).toEqual(UNION);
		const foreign = evalSymbol(index, "TopForeign");
		expect(Object.keys(prop(foreign, "tool").properties as object)).toEqual([
			"name",
			"permission_policy",
			"org_max_permission",
		]);
	});
});

// ---------------------------------------------------------------------------
// The guard against fixing this by widening the net
// ---------------------------------------------------------------------------

describe("an alias resolves only within its own module", () => {
	it("leaves an alias whose target is bound only in ANOTHER module unindexed", () => {
		// `Alias=z4e` in a module that has no `z4e` of its own. The frontmatter
		// module's `z4e` is a real factory, but nothing says this module's
		// `z4e` is the same symbol — minified names are module-scoped.
		// Recording it would fabricate on a guess, so it stays out and the
		// reference degrades to `{}`.
		const index = indexModules([
			frontmatterModule(),
			[
				`import{c,i}from"/$bunfs/root/chunk-abc123.js";`,
				`var Alias=z4e;`,
				// `k`/`j` keep the module above `normalizeZodModule`'s three-call
				// floor so it is recognised as a Zod module at all.
				`var TopStray=m(()=>c({x:Alias(),k:i(),j:i()}));`,
				`export{Alias,TopStray};`,
			].join(""),
		]);
		expect(index.defSites.get("Alias")).toBeUndefined();
		const top = evalSymbol(index, "TopStray");
		expect(prop(top, "x")).toEqual({});
	});

	it("follows an alias chain when every hop is in the same module", () => {
		const index = indexModules([
			foreignModule(),
			[
				`import{c,Ge,i,A}from"/$bunfs/root/chunk-abc123.js";`,
				`var z4e=()=>Ge([i(),A()]),Mid=z4e,BU=Mid;`,
				`var TopChain=m(()=>c({y:BU()}));`,
				`export{z4e,Mid,BU,TopChain};`,
			].join(""),
		]);
		const top = evalSymbol(index, "TopChain");
		expect(prop(top, "y").anyOf).toEqual([
			{ type: "string" },
			{ type: "number" },
		]);
	});

	it("does not follow an alias chain across a module boundary", () => {
		// Module 2 aliases `Mid`, which is itself an alias only in module 1.
		const index = indexModules([
			[
				`import{c,Ge,i,A}from"/$bunfs/root/chunk-abc123.js";`,
				`var z4e=()=>Ge([i(),A()]),Mid=z4e;`,
				`var Top1=m(()=>c({a:Mid()}));`,
				`export{z4e,Mid,Top1};`,
			].join(""),
			[
				`import{c,i}from"/$bunfs/root/chunk-abc123.js";`,
				`var Far=Mid;`,
				`var Top2=m(()=>c({b:Far(),k:i(),j:i()}));`,
				`export{Far,Top2};`,
			].join(""),
		]);
		expect(index.defSites.get("Far")).toBeUndefined();
		expect(prop(evalSymbol(index, "Top2"), "b")).toEqual({});
		// Module 1's own chain is unaffected.
		expect(prop(evalSymbol(index, "Top1"), "a").anyOf).toEqual([
			{ type: "string" },
			{ type: "number" },
		]);
	});
});
