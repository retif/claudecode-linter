/**
 * Plugin schema extraction from the 2.1.322 field registry.
 *
 * 2.1.322 stopped building plugin.json's schema as one Zod object. The
 * validator now calls `<fn>(h).safeParse(h)`, `<fn>` returns
 * `<reg>().forDocument(e,"strip")`, and `<reg>` is a lazily built registry of
 * per-field thunks (`name:()=>Ie().shape.name`, `hooks:()=>za().partial()
 * .shape.hooks`, …). Neither earlier locator matches — strategy 2's
 * `<sym>().safeParse(` needs an empty argument list — and a new wrapper
 * (`Iu(w,"plugin-json",s)` → `dTe(…)`) is now the FIRST "plugin-json" call site
 * in the corpus, so a first-site search lands on the wrong function anyway.
 *
 * In-memory module fragments, not a real binary, so these stay stable across
 * releases.
 */

import { describe, expect, it } from "vitest";
import {
	buildCorpusWithRanges,
	buildPluginSchema,
	findMasterSchemaName,
	findPluginFieldRegistry,
	indexDefinitions,
	parseFieldRegistry,
} from "../../scripts/extract-plugin-schema.js";
import type { DefinitionIndex } from "../../scripts/extract-plugin-schema.js";

function pad(): string {
	return `var PAD="${"x".repeat(5000)}";`;
}

/** The module holding the sub-schemas and the field registry. */
function schemaModule(): string {
	return [
		`var Ie=CH(()=>E.object({name:E.string().min(1),version:E.string().optional(),description:E.string().optional()}));`,
		`var za=CH(()=>E.object({hooks:E.union([E.string(),E.record(E.string(),E.any())])}));`,
		`var reg=CH(()=>new Xt({name:()=>Ie().shape.name,version:()=>Ie().shape.version,`,
		`description:()=>Ie().shape.description,hooks:()=>za().partial().shape.hooks,`,
		`weird:()=>someRuntimeThing()},new Set(["name"])));`,
		`function gaa(e){return reg().forDocument(e,"strip")}`,
	].join("");
}

/** The validator module: dispatches on "plugin-json" and safeParses gaa(h). */
function validatorModule(): string {
	return [
		`function dTe(e,n,r){let h={...e};let ke=gaa(h).safeParse(h);return ke.success?{ok:!0}:{ok:!1}}`,
		pad(),
		`function lint(m,p){let c=dTe(m,"plugin-json",{manifestPath:p});return c}`,
	].join("");
}

/**
 * A wrapper that dispatches with "plugin-json" before the real validator, plus
 * an unrelated same-named function whose body does contain a `.safeParse(`.
 */
function wrapperModule(): string {
	return [
		`function Iu(e,n,r){return dTe(e,n,{pluginName:r})}`,
		`function load(w,s){let b=Iu(w,"plugin-json",s);return b}`,
	].join("");
}
function decoyModule(): string {
	return `function Iu(){let a=Fu().safeParse(x);return a}${pad()}`;
}

function indexModules(modules: string[]): DefinitionIndex {
	const corpus = buildCorpusWithRanges(modules);
	return indexDefinitions(corpus.source, corpus.moduleRanges);
}

describe("plugin.json field registry (2.1.322)", () => {
	const modules = [decoyModule(), wrapperModule(), schemaModule(), validatorModule()];

	it("is not masked when strategy 2 names a decoy master", () => {
		// The decoy `Iu` satisfies strategy 2's `<sym>().safeParse(` test, so it
		// names `Fu` — which resolves to nothing. buildPluginSchema must still
		// reach the registry (asserted below), not stop at the bogus master.
		expect(findMasterSchemaName(indexModules(modules))).toBe("Fu");
	});

	it("finds the registry past the wrapper and the decoy", () => {
		const reg = findPluginFieldRegistry(indexModules(modules));
		expect(reg?.fields.map((f) => f.key)).toEqual([
			"name",
			"version",
			"description",
			"hooks",
			"weird",
		]);
	});

	it("builds the schema from the registry's sub-schema fields", () => {
		const schema = buildPluginSchema(indexModules(modules));
		expect(schema).not.toBeNull();
		const props = schema?.properties as Record<string, Record<string, unknown>>;
		expect(Object.keys(props)).toEqual([
			"name",
			"version",
			"description",
			"hooks",
			"weird",
		]);
		expect(props.name.type).toBe("string");
		expect(props.hooks.anyOf).toBeDefined();
		// A thunk the walker cannot read degrades to permissive, not dropped.
		expect(props.weird).toEqual({});
		// Required follows the sub-schema, only for non-partial reads.
		expect(schema?.required).toEqual(["name"]);
	});
});

describe("parseFieldRegistry", () => {
	it("rejects a registry without a name field", () => {
		expect(
			parseFieldRegistry(`CH(()=>new Xt({model:()=>A().shape.model}))`, "CH"),
		).toBeNull();
	});

	it("rejects an object that is not mostly thunks", () => {
		expect(
			parseFieldRegistry(`CH(()=>new Xt({name:1,a:2,b:3}))`, "CH"),
		).toBeNull();
	});

	it("rejects a non-constructor value", () => {
		expect(parseFieldRegistry(`CH(()=>E.object({name:E.string()}))`, "CH")).toBeNull();
	});
});
