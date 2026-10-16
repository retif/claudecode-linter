/**
 * The 2.1.301 bundle layout: settings as a thunk map, hooks config as a plain
 * `record`, factories declared as functions with parameters, forwarding
 * function aliases, and `...union.options` spreads.
 *
 * Every scheduled release run from 2026-10-13 failed the schema gate with
 * "Settings schema lost 544/544 property paths" and "Hooks config schema lost
 * 47/48": the settings fields had become `return{$schema:()=>…,…}` inside a
 * factory, with no `<alias>.object(` to anchor on, so the walker landed on an
 * unrelated credentials object; and the hooks config had become
 * `y.record(y.enum(ev),…)` with no `partialRecord` left in the corpus, so the
 * `record` fallback accepted the first record that was an object — a model
 * table. Each test here pins one of the shapes, on in-memory fragments.
 */

import { describe, it, expect } from "vitest";
import {
	buildCorpusWithRanges,
	buildHooksJsonSchema,
	buildSettingsSchema,
	collectLocalBindings,
	evalZod,
	findSettingsThunkMap,
	indexDefinitions,
	looksLikeHooksConfig,
	resolveDefSite,
} from "../../scripts/extract-plugin-schema.js";
import type {
	DefinitionIndex,
	JSONSchema,
} from "../../scripts/extract-plugin-schema.js";

const ANCHOR = "JSON Schema reference for Claude Code settings";

function props(schema: JSONSchema | undefined): Record<string, JSONSchema> {
	return (schema?.properties as Record<string, JSONSchema>) ?? {};
}

/** Legacy single-module bundle: alias `E`, lazy wrapper `CH`. */
function settingsBundle(): string {
	return [
		`var ev=["PreToolUse","PostToolUse"]`,
		// A model table that is a `record` of objects, declared BEFORE the hooks
		// config so the `record` fallback meets it first.
		`,MD=CH(()=>E.record(E.string(),E.object({advisor_rank:E.number(),context:E.object({window:E.number()})})))`,
		`,MT=CH(()=>E.object({matcher:E.string().optional().describe("pattern"),hooks:E.array(E.string())}))`,
		`,HC=CH(()=>E.record(E.enum(ev),E.array(MT())))`,
		`,MK=CH(()=>E.object({source:E.string(),autoUpdate:E.boolean().optional()}))`,
		// Module-level `r`: an mcp_tool hook entry. The settings factory declares
		// its own local `r` that must shadow this one.
		`,r=CH(()=>E.object({tool:E.string(),server:E.string()}))`,
		// The object literal nearest to the anchor — what the old walk-back took
		// for the settings object.
		`,CR=CH(()=>E.object({credentials:E.string()}))`,
		`;function DO(e){let n;return new cr({type:"lazy",getter:()=>e()})}`,
		`function SF(e,{strict:n=!1}={}){`,
		`function r(i){return E.record(E.string(),MK()).check((c)=>{})}`,
		`let s=(i,c)=>n?i:i.catch(void 0);`,
		`return{$schema:()=>E.string().optional().describe("${ANCHOR}"),`,
		`extra:()=>DO(()=>r("extra")).describe("extra marketplaces"),`,
		`hooks:()=>DO(()=>HC()).describe("hooks"),`,
		`policy:()=>s(MK().optional(),(i)=>i).describe("policy helper"),`,
		`attribution:()=>{let i=E.object({commit:E.string().optional()}).passthrough();return E.union([E.boolean(),i])},`,
		`...!1,...G(j(e),(i)=>()=>i)}}`,
		`function run(e){return new $n(SF(e)).whole()}`,
	].join("");
}

describe("settings as a thunk map (2.1.301)", () => {
	const index = indexDefinitions(settingsBundle());

	it("locates the map enclosing the anchor and rewrites it as an object", () => {
		const anchorIdx = index.source.lastIndexOf(ANCHOR);
		const found = findSettingsThunkMap(index.source, anchorIdx, index.zodAlias);
		expect(found).not.toBeNull();
		expect(found!.expr.startsWith("E.object({")).toBe(true);
		expect(found!.expr.endsWith("}).passthrough()")).toBe(true);
		// Thunks are unwrapped; spreads are dropped.
		expect(found!.expr).toContain("$schema:E.string()");
		expect(found!.expr).not.toContain("()=>E.string()");
		expect(found!.expr).not.toContain("...!1");
		expect(found!.expr).not.toContain("G(j(e)");
	});

	it("binds the factory's local helpers from its prelude", () => {
		const anchorIdx = index.source.lastIndexOf(ANCHOR);
		const found = findSettingsThunkMap(index.source, anchorIdx, index.zodAlias);
		expect(found!.bindings.get("r")).toBe(
			"E.record(E.string(),MK()).check((c)=>{})",
		);
		expect(found!.bindings.get("s")).toBe("(i,c)=>n?i:i.catch(void 0)");
	});

	it("builds the settings schema from the thunk map, not the nearest object", () => {
		const schema = buildSettingsSchema(index);
		expect(schema).not.toBeNull();
		const p = props(schema!);
		expect(p.$schema).toMatchObject({ type: "string", description: ANCHOR });
		// Not the `credentials` object the old walk-back landed on.
		expect(p.credentials).toBeUndefined();
		// Still permissive, still no required keys.
		expect(schema!.additionalProperties).toBe(true);
		expect(schema!.required).toBeUndefined();
	});

	it("sees through the deferred wrapper to the hooks config", () => {
		const p = props(buildSettingsSchema(index)!);
		const perEvent = p.hooks.additionalProperties as JSONSchema;
		expect(props(perEvent.items as JSONSchema).hooks).toMatchObject({
			type: "array",
		});
		expect(p.hooks.description).toBe("hooks");
	});

	it("resolves a local helper ahead of a same-named module factory", () => {
		const p = props(buildSettingsSchema(index)!);
		const entry = p.extra.additionalProperties as JSONSchema;
		// The local `r(i)` is a record of marketplace entries …
		expect(props(entry).source).toMatchObject({ type: "string" });
		// … not the module-level `r`, an mcp_tool hook entry.
		expect(props(entry).tool).toBeUndefined();
		expect(JSON.stringify(p.extra)).not.toContain('"server"');
	});

	it("degrades a helper it cannot evaluate to a permissive placeholder", () => {
		const p = props(buildSettingsSchema(index)!);
		expect(p.policy.properties).toBeUndefined();
		expect(p.policy.description).toBe("policy helper");
	});

	it("evaluates a block-bodied thunk through its `let` bindings", () => {
		const p = props(buildSettingsSchema(index)!);
		const branches = p.attribution.anyOf as JSONSchema[];
		expect(branches).toHaveLength(2);
		expect(branches[0]).toEqual({ type: "boolean" });
		expect(props(branches[1]).commit).toMatchObject({ type: "string" });
	});

	it("returns null for an anchor no thunk map encloses", () => {
		const legacy = `var S=CH(()=>E.object({$schema:E.string().describe("${ANCHOR}")}).passthrough());`;
		const idx = indexDefinitions(legacy);
		expect(
			findSettingsThunkMap(idx.source, idx.source.lastIndexOf(ANCHOR), "E"),
		).toBeNull();
		// … and the legacy walk-back still builds the schema.
		expect(props(buildSettingsSchema(idx)!).$schema).toMatchObject({
			type: "string",
		});
	});
});

describe("hooks config as a plain record (2.1.301)", () => {
	const index = indexDefinitions(settingsBundle());

	it("skips a record that is an object but not the hooks shape", () => {
		const schema = buildHooksJsonSchema(index);
		expect(schema).not.toBeNull();
		const hooks = props(schema!).hooks;
		const entry = (hooks.additionalProperties as JSONSchema).items as JSONSchema;
		expect(props(entry).hooks).toMatchObject({ type: "array" });
		expect(props(entry).matcher).toMatchObject({ type: "string" });
		expect(JSON.stringify(schema)).not.toContain("advisor_rank");
	});

	it("looksLikeHooksConfig accepts the documented shape only", () => {
		expect(
			looksLikeHooksConfig({
				type: "object",
				additionalProperties: {
					type: "array",
					items: { type: "object", properties: { hooks: { type: "array" } } },
				},
			}),
		).toBe(true);
		expect(
			looksLikeHooksConfig({
				type: "object",
				additionalProperties: {
					type: "object",
					properties: { advisor_rank: { type: "number" } },
				},
			}),
		).toBe(false);
		expect(looksLikeHooksConfig({ type: "object" })).toBe(false);
	});
});

describe("factories declared as functions with parameters", () => {
	const bundle = [
		`function KA(e){return E.discriminatedUnion("source",[E.object({source:E.literal("url"),url:E.string()}),E.object({source:E.literal("git"),repo:E.string()})])}`,
		`var AA=CH(()=>KA(!0))`,
		`,WO=CH(()=>{let e=AA();return E.discriminatedUnion("source",[E.object({source:E.literal("dir")}),...e.options])})`,
		`,ZZ=CH(()=>QQ(1))`,
		`,PP=CH(()=>E.object({a:E.string()}));`,
	].join("");
	const index = indexDefinitions(bundle);
	const ctx = () => ({ index, resolving: new Set<string>(), module: -1 });

	it("indexes `function f(e){return <alias>…}` and follows `f(args)`", () => {
		const out = evalZod("AA()", ctx());
		expect(out.oneOf).toHaveLength(2);
		expect(props((out.oneOf as JSONSchema[])[0]).url).toMatchObject({
			type: "string",
		});
	});

	it("leaves a call to an unindexed helper permissive", () => {
		expect(evalZod("ZZ()", ctx())).toEqual({});
	});

	it("splices `...<union>.options` into the enclosing union", () => {
		const out = evalZod("WO()", ctx());
		const branches = out.oneOf as JSONSchema[];
		expect(branches).toHaveLength(3);
		expect(props(branches[0]).source).toEqual({ const: "dir" });
		expect(props(branches[1]).source).toEqual({ const: "url" });
		expect(props(branches[2]).source).toEqual({ const: "git" });
	});

	it("leaves a spread of something that is not a union permissive", () => {
		const idx = indexDefinitions(
			`var PP=CH(()=>E.object({a:E.string()})),WO=CH(()=>{let e=PP();return E.union([E.boolean(),...e.options])});`,
		);
		const out = evalZod("WO()", { index: idx, resolving: new Set(), module: -1 });
		expect(out.anyOf).toEqual([{ type: "boolean" }, {}]);
	});
});

describe("forwarding function aliases across modules", () => {
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
			`function i(e){return Sn(Sym0,e)}`,
			`function T(e){return Sn(Sym4,e)}`,
			`export{c,i,T};`,
		].join("");
	}
	// Declared first, so the corpus-wide fallback would pick it.
	const elicitation = [
		`import{c,i}from"/$bunfs/root/chunk-abc123.js";`,
		`var Oa=m(()=>c({subtype:i(),mcp_server_name:i()}));`,
		`export{Oa};`,
	].join("");
	const settings = [
		`import{c,i,T}from"/$bunfs/root/chunk-abc123.js";`,
		`var Aa=m(()=>c({source:i()}));`,
		`function Oa(){return Aa()}`,
		`var Cn=m(()=>Oa()),Top=m(()=>c({list:T(Cn())}));`,
		`export{Top};`,
	].join("");

	it("resolves `function Oa(){return Aa()}` in its own module, not elsewhere", () => {
		const corpus = buildCorpusWithRanges([zodChunk(), elicitation, settings]);
		const index: DefinitionIndex = indexDefinitions(
			corpus.source,
			corpus.moduleRanges,
		);
		const site = resolveDefSite(index, "Top")!;
		const out = evalZod(site.value, {
			index,
			resolving: new Set(),
			module: site.module,
		});
		const item = (props(out).list.items as JSONSchema) ?? {};
		expect(props(item).source).toMatchObject({ type: "string" });
		expect(props(item).subtype).toBeUndefined();
	});
});

describe("collectLocalBindings", () => {
	it("binds function declarations and let/var/const declarations", () => {
		const bindings = new Map<string, string>();
		collectLocalBindings(
			`function r(i){return E.record(E.string(),MK())}let s=(i,c)=>i,q=E.string();const z=E.number();`,
			bindings,
		);
		expect(bindings.get("r")).toBe("E.record(E.string(),MK())");
		expect(bindings.get("s")).toBe("(i,c)=>i");
		expect(bindings.get("q")).toBe("E.string()");
		expect(bindings.get("z")).toBe("E.number()");
	});

	it("never overwrites an existing binding", () => {
		const bindings = new Map<string, string>([["r", "KEEP"]]);
		collectLocalBindings(`function r(){return E.string()}`, bindings);
		expect(bindings.get("r")).toBe("KEEP");
	});

	it("ignores a function whose body is not a single return", () => {
		const bindings = new Map<string, string>();
		collectLocalBindings(`function r(i){if(i)return E.string();return E.number()}`, bindings);
		expect(bindings.has("r")).toBe(false);
	});
});
