/**
 * Unit tests for the two Claude Code 2.1.328–2.1.331 bundle changes that broke
 * the Release job (oleks/claudecode-linter#57):
 *
 *  - 2.1.331 builds Claude Code's own schemas with a class-based runtime that
 *    keeps Zod's call surface but carries neither of the signals
 *    `mapZodFactories` reads (`type:"…"` def literals, `"ZodFoo"` class
 *    strings). Every consumer module failed to normalise, and the definition
 *    index fell from ~1,500 to 211.
 *  - 2.1.328 declares the plugin manifest's inline MCP server union as a block
 *    body that array-destructures another union's `.options`
 *    (`{let[e,...n]=X().options;return y.union([e.extend({…}),...n])}`), and
 *    the walker bound nothing, so `mcpServers` lost every server field.
 *
 * The fragments are trimmed from 2.1.331/2.1.332, with the minified names kept.
 */

import { describe, it, expect } from "vitest";
import {
	buildCorpus,
	collectZodFactories,
	evalZod,
	indexDefinitions,
	mapClassFactories,
	CANONICAL_ZOD_ALIAS,
} from "../../scripts/extract-plugin-schema.js";

/**
 * The class-based runtime. It needs at least CLASS_RUNTIME_FLOOR (10)
 * `get type(){return"…"}` classes to be recognised, and it uses inheritance
 * the way the real one does: `N1o extends k`, `pe extends I7n`.
 */
function classRuntime(): string {
	return [
		`class Mne{constructor(e,t){this.error=e}}`,
		`class k extends Mne{get type(){return"string"}read(e,t){return e}}`,
		`class N1o extends k{email(e){return this}}`,
		`class x7n extends Mne{get type(){return"number"}}`,
		`class F1o extends Mne{get type(){return"boolean"}}`,
		`class j extends Mne{read(e,t){return e}}`,
		`class A extends j{get type(){return"unknown"}}`,
		`class P7n extends Mne{get type(){return"never"}}`,
		`class O7n extends Mne{constructor(e,t){super(t);this.values=e}get type(){return"literal"}}`,
		`class Tvn extends Mne{get type(){return"enum"}}`,
		`class I7n extends Mne{constructor(e,t){super(t);this.options=e}get type(){return"union"}}`,
		`class pe extends I7n{discriminator;constructor(e,t,n){super(t,n);this.discriminator=e}}`,
		`class w extends Mne{}`,
		`class Avn extends w{get type(){return"array"}}`,
		`class W1o extends w{constructor(e,t,n,i){super(i);this.isPartial=n}get type(){return"record"}}`,
		`class Fye extends w{constructor(e,t,n){super(n);this.given=e;this.others=t}get type(){return"object"}}`,
		`function r(e){return new N1o(e)}`,
		`function E(e){return new x7n(e)}`,
		`function M(e){return new F1o(e)}`,
		`function de(){return new A}`,
		`function x(e,t){return new O7n(Array.isArray(e)?e:[e],t)}`,
		`function U(e,t){return new Tvn(e,t)}`,
		`function I(e,t){return new Avn(e,t)}`,
		`function Te(e,t,n){return new W1o(e,t,!1,n)}`,
		`function GBe(e,t){return new W1o(e,t,!0)}`,
		`function c(e,t){return new Fye(e,void 0,t)}`,
		`function xe(e,t){return new Fye(e,new P7n,t)}`,
		`function Fn(e,t){return new Fye(e,new A,t)}`,
		`function lt(e,t){return new I7n(e,t)}`,
		`function Fr(e,t,n){return new pe(e,t,n)}`,
		`export{r,E,M,de,x,U,I,Te,GBe,c,xe,Fn,lt,Fr};`,
	].join("");
}

/** A 2.1.331-style consumer: the LSP server schema, trimmed. */
function lspConsumer(): string {
	return [
		`import{r,I,Te,U,xe,E,c}from"/$bunfs/root/chunk-x88b33vg.js";`,
		`var i1r=p(()=>xe({command:r().min(1),args:I(r()).optional(),`,
		`extensionToLanguage:Te(r(),r()),transport:U(["stdio","socket"]).optional(),`,
		`startupTimeout:E().optional()})),`,
		// Alias detection counts `<alias>.object({` sites; real modules have many.
		`ch=p(()=>c({server:r().min(1)}));`,
		`export{i1r,ch};`,
	].join("");
}

describe("class-based schema runtime (2.1.331+)", () => {
	it("maps each factory through its class's type getter", () => {
		const f = mapClassFactories(classRuntime());
		expect(Object.fromEntries(f)).toEqual({
			r: "string",
			E: "number",
			M: "boolean",
			de: "unknown",
			x: "literal",
			U: "enum",
			I: "array",
			Te: "record",
			GBe: "partialRecord",
			c: "object",
			xe: "strictObject",
			Fn: "looseObject",
			lt: "union",
			Fr: "discriminatedUnion",
		});
	});

	it("resolves the kind through `extends` (a string subclass is a string)", () => {
		const f = mapClassFactories(
			`${classRuntime()}function K9(e){return new N1o(e)}`,
		);
		expect(f.get("K9")).toBe("string");
	});

	it("ignores a function whose constructed class names no kind", () => {
		const f = mapClassFactories(`${classRuntime()}function zz(e){return new w(e)}`);
		expect(f.has("zz")).toBe(false);
	});

	it("only harvests from modules that look like a class runtime", () => {
		// Two typed classes are far below the floor: an app module that happens
		// to declare `get type()` getters must not seed the factory map.
		const appModule =
			`class Q{get type(){return"object"}}class R{get type(){return"string"}}` +
			`function c(e){return new Q(e)}function r(e){return new R(e)}`;
		expect(collectZodFactories([appModule]).size).toBe(0);
		expect(collectZodFactories([classRuntime()]).get("c")).toBe("object");
	});

	it("makes a class-runtime corpus indexable end to end", () => {
		const corpus = buildCorpus([classRuntime(), lspConsumer()]);
		const index = indexDefinitions(corpus);
		expect(index.zodAlias).toBe(CANONICAL_ZOD_ALIAS);
		const def = index.defs.get("i1r");
		expect(def).toBeDefined();
		const schema = evalZod(def as string, { index, resolving: new Set() });
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(Object.keys(schema.properties ?? {})).toEqual([
			"command",
			"args",
			"extensionToLanguage",
			"transport",
			"startupTimeout",
		]);
		expect(schema.required).toEqual(["command", "extensionToLanguage"]);
		expect(schema.properties?.transport).toMatchObject({
			enum: ["stdio", "socket"],
		});
	});
});

describe("array destructure over a union's .options (2.1.328+)", () => {
	// Trimmed from 2.1.332's plugin manifest: `V4s` adds `network` to the
	// first (stdio) server branch and keeps the rest of `wwe`'s members as-is.
	const bundle =
		`var p=(e)=>e;var ` +
		`nJt=p(()=>y.object({type:y.literal("stdio").optional(),command:y.string()})),` +
		`UZn=p(()=>y.object({type:y.literal("sse"),url:y.string()})),` +
		`St=p(()=>y.object({type:y.literal("http"),url:y.string()})),` +
		`wwe=p(()=>y.union([nJt(),UZn(),St()])),` +
		`V4s=p(()=>{let[e,...n]=wwe().options;return y.union([e.extend({network:y.array(y.string()).optional()}),...n])}),` +
		`pad=p(()=>y.object({a:y.string(),b:y.number(),c:y.boolean()}));`;

	it("binds the head member, extends it, and spreads the rest in place", () => {
		const index = indexDefinitions(bundle);
		const out = evalZod("V4s()", { index, resolving: new Set() });
		const members = (out.anyOf ?? out.oneOf) as Array<{
			properties?: Record<string, unknown>;
		}>;
		expect(members).toHaveLength(3);
		expect(Object.keys(members[0].properties ?? {})).toEqual([
			"type",
			"command",
			"network",
		]);
		expect(members[1].properties?.type).toEqual({ const: "sse" });
		expect(members[2].properties?.type).toEqual({ const: "http" });
	});

	it("degrades to permissive when the destructured value is not a union", () => {
		const index = indexDefinitions(
			`${bundle.slice(0, -1)},bad=p(()=>{let[e,...n]=pad().options;return y.union([e,...n])});`,
		);
		const out = evalZod("bad()", { index, resolving: new Set() });
		// Nothing was bound, so the block body is not understood: `{}`, never
		// a fabricated shape.
		expect(out).toEqual({});
	});
});
