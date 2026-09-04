/**
 * Local factory shapes the definition index must recognise
 * (oleks/claudecode-linter#41).
 *
 * `extract-plugin-schema-module-scope.test.ts` pins the resolution ORDER: a
 * reference prefers its own module's binding. That is only worth anything if
 * the index can SEE its own module's binding. Where it cannot, the miss is not
 * neutral — `resolveDefSite` finds nothing local, falls through to a same-named
 * binding in an unrelated module, and the walker emits that foreign schema as
 * if it were this field's. The run exits 0 and the drift gate sees a schema
 * that merely looks different, not one that is wrong.
 *
 * That is what happened on 2.1.259, which typed three settings fields from
 * unrelated modules and published 87 property paths that are in no upstream
 * source:
 *
 *   accessKeyIdVar    "Name of the masked env var holding the AWS access key
 *                     id." — emitted as a TodoWrite item ({id, subject, status,
 *                     blocks, blockedBy, activeForm, …}). Really
 *                     `He=()=>z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/…)`.
 *   autoCompactWindow "Auto-compact window size" — emitted as a six-member
 *                     experiment-arm discriminated union. Really
 *                     `cc=()=>z.number().int().min(…).max(…).optional()`.
 *   headersHelper     "Command that prints a JSON object of HTTP headers" —
 *                     emitted as {type,text} on 2.1.259 and as an OAuth token
 *                     object on 2.1.260. Really
 *                     `function bn(){return z.string().max(…)}`.
 *
 * Two distinct blind spots, one mechanism:
 *
 *  1. the bare-arrow scan enumerated only the COMPOSITE Zod methods
 *     (object/strictObject/union/discriminatedUnion/lazy), so every primitive
 *     factory was invisible;
 *  2. the scan anchors on `=`, so a factory declared as a function STATEMENT
 *     had nothing to anchor on and was invisible at any method.
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
 * A stand-in for the bundle's Zod runtime chunk — the same one the module-scope
 * tests use. `collectZodFactories` only treats a module as a Zod chunk when it
 * declares at least 10 `X=Y("ZodFoo"` class symbols, so declare a full set.
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
 * The FOREIGN module: binds the shared names to unrelated OBJECT schemas, in
 * the shape the index has always recognised. Placed first in the corpus so
 * `defSites.get(name)[0]` is this module — i.e. so a miss in the victim module
 * lands here, exactly as `accessKeyIdVar` landed on the TodoWrite item.
 */
function foreignModule(): string {
	return [
		`import{c,i,A}from"/$bunfs/root/chunk-abc123.js";`,
		`var He=m(()=>c({todoId:i(),todoStatus:i()}));`,
		`var Bn=m(()=>c({type:i(),text:i()}));`,
		`var Cc=m(()=>c({arm:i(),weight:A()}));`,
		`var TopForeign=m(()=>c({inner:He()}));`,
		`export{He,Bn,Cc,TopForeign};`,
	].join("");
}

/**
 * The VICTIM module: declares its own `He`, `Bn` and `Cc` as local factories in
 * the two shapes the index used to miss, and refers to them from an entry
 * point. Every field here is a primitive upstream.
 */
function victimModule(): string {
	return [
		`import{c,i,A}from"/$bunfs/root/chunk-abc123.js";`,
		// Shape 1: bare-arrow PRIMITIVE factories.
		`var He=()=>i().max(64),Cc=()=>A().optional();`,
		// Shape 2: a function STATEMENT factory — no `=` to anchor on.
		`function Bn(){return i().max(1024)}`,
		`var TopVictim=m(()=>c({accessKeyIdVar:He(),autoCompactWindow:Cc(),headersHelper:Bn()}));`,
		`export{He,Bn,Cc,TopVictim};`,
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

// ---------------------------------------------------------------------------
// The blind spots
// ---------------------------------------------------------------------------

describe("local factory shapes the index must recognise", () => {
	it("indexes a bare-arrow PRIMITIVE factory, not just the composite ones", () => {
		// `He=()=>i().max(64)` — before #41 the bare-arrow scan named only
		// object/strictObject/union/discriminatedUnion/lazy, so this was
		// invisible and `He` resolved into `foreignModule`.
		const index = indexModules([foreignModule(), victimModule()]);
		const sites = index.defSites.get("He");
		expect(sites, "He must be bound in BOTH modules").toHaveLength(2);
	});

	it("indexes a function-STATEMENT factory, which has no `=` to anchor on", () => {
		// `function Bn(){return i().max(1024)}`. The whole `<name>=<factory>`
		// scan cannot see this shape at any Zod method.
		const index = indexModules([foreignModule(), victimModule()]);
		const sites = index.defSites.get("Bn");
		expect(sites, "Bn must be bound in BOTH modules").toHaveLength(2);
	});

	it("does not index a function statement whose body is not a Zod expression", () => {
		// The guard against fixing this by widening the net. A body returning a
		// helper call could be anything; resolving it on a guess would fabricate
		// exactly the way the bug under test does.
		const index = indexModules([
			foreignModule(),
			[
				`import{c,i}from"/$bunfs/root/chunk-abc123.js";`,
				`function Nope(){return someHelper().whatever()}`,
				`var TopNope=m(()=>c({x:i()}));`,
				`export{Nope,TopNope};`,
			].join(""),
		]);
		expect(index.defSites.get("Nope")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The consequence — what an unindexed local binding actually produces
// ---------------------------------------------------------------------------

describe("an unindexed local binding fabricates a foreign schema", () => {
	it("types every primitive field from its OWN module, not the foreign one", () => {
		// The acceptance test for #41. Before the fix all three of these came
		// out as `foreignModule`'s objects — which is how a field documented as
		// "Name of the masked env var holding the AWS access key id." shipped
		// as a TodoWrite item with `blockedBy` and `activeForm`.
		const index = indexModules([foreignModule(), victimModule()]);
		const top = evalSymbol(index, "TopVictim");

		expect(prop(top, "accessKeyIdVar").type).toBe("string");
		expect(prop(top, "autoCompactWindow").type).toBe("number");
		expect(prop(top, "headersHelper").type).toBe("string");

		// Not merely "the right type" — none of them carries the foreign shape.
		for (const key of [
			"accessKeyIdVar",
			"autoCompactWindow",
			"headersHelper",
		]) {
			expect(prop(top, key).properties, `${key} must not be an object`)
				.toBeUndefined();
		}
	});

	it("still resolves the FOREIGN module's own bindings to its own schemas", () => {
		// The other half, and the reason this is a fix rather than a mute
		// button: making the victim resolve locally must not stop the module
		// that genuinely does bind these names to objects from getting them.
		const index = indexModules([foreignModule(), victimModule()]);
		const top = evalSymbol(index, "TopForeign");
		expect(Object.keys(prop(top, "inner").properties as object)).toEqual([
			"todoId",
			"todoStatus",
		]);
	});

	it("leaves a name bound in only ONE module resolving cross-module", () => {
		// A local binding must win where one exists; where none does, a
		// cross-module reference is normal and must still resolve. Narrowing
		// that would trade fabricated paths for lost real ones.
		const index = indexModules([foreignModule(), victimModule()]);
		const site = resolveDefSite(index, "Cc", 999);
		expect(site).not.toBeNull();
	});
});
