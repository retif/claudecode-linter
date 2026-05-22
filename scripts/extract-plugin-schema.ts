#!/usr/bin/env tsx
/**
 * Extracts the plugin.json Zod validator from Claude Code's cli.js bundle and
 * translates it to a JSON Schema (draft-2020-12) suitable for Ajv validation.
 *
 * Strategy:
 *   1. Find the master CSH-like schema by anchoring on .strict().safeParse near
 *      the "kebab-case" name-validation error message in oL$().
 *   2. Parse its body: { ...subN().shape, ...subM().partial().shape, ... }.
 *   3. Recursively resolve each <sub> = CH(() => <ZodExpr>) definition.
 *   4. Walk Zod call chains and emit JSON Schema. Unknown patterns degrade to
 *      `{}` (permissive) rather than failing — better to under-validate than
 *      reject a valid file.
 *
 * Output: contracts/plugin.schema.json
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

// ---------------------------------------------------------------------------
// 1. Bundle acquisition — duplicates fetchCliSource from extract-contracts.ts.
//    Kept inline so this extractor can run standalone.
// ---------------------------------------------------------------------------

export interface BundleResult {
	source: string;
	version: string;
}

export function fetchBundle(requestedVersion?: string): BundleResult {
	const npmPkg = requestedVersion
		? `@anthropic-ai/claude-code@${requestedVersion}`
		: "@anthropic-ai/claude-code";
	const tmp = mkdtempSync(join(tmpdir(), "claude-plugin-schema-"));
	try {
		execSync(`npm pack ${npmPkg} --pack-destination .`, {
			cwd: tmp,
			stdio: "pipe",
		});
		const tgz = execSync("ls *.tgz", { cwd: tmp, encoding: "utf8" }).trim();
		execSync(`tar xzf "${tgz}"`, { cwd: tmp, stdio: "pipe" });
		const pkg = JSON.parse(
			readFileSync(join(tmp, "package", "package.json"), "utf8"),
		);
		const legacyCli = join(tmp, "package", "cli.js");
		if (existsSync(legacyCli)) {
			return { source: readFileSync(legacyCli, "utf8"), version: pkg.version };
		}
		const platformDir = join(tmp, "platform");
		mkdirSync(platformDir);
		execSync(
			`npm pack @anthropic-ai/claude-code-linux-x64@${pkg.version} --pack-destination .`,
			{ cwd: platformDir, stdio: "pipe" },
		);
		const ptgz = execSync("ls *.tgz", {
			cwd: platformDir,
			encoding: "utf8",
		}).trim();
		execSync(`tar xzf "${ptgz}"`, { cwd: platformDir, stdio: "pipe" });
		const binary = readFileSync(join(platformDir, "package", "claude"));
		const versionMarker = Buffer.from(`// Version: ${pkg.version}`);
		const versionIdx = binary.indexOf(versionMarker);
		const bunMarker = Buffer.from("// @bun @bytecode @bun-cjs");
		const bundleStart = binary.lastIndexOf(bunMarker, versionIdx);
		const slice = binary
			.subarray(bundleStart, Math.min(bundleStart + 60_000_000, binary.length))
			.toString("utf8");
		return { source: slice, version: pkg.version };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 2. Generic source helpers
// ---------------------------------------------------------------------------

/** Find balanced delimiter pair starting at the opener position. */
export function extractBalanced(
	src: string,
	openIdx: number,
	open: string,
	close: string,
): string {
	let depth = 0;
	let inStr: string | null = null;
	for (let i = openIdx; i < src.length; i++) {
		const c = src[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return src.slice(openIdx, i + 1);
		}
	}
	return "";
}

/** Split a top-level argument list (already stripped of outer parens). */
export function splitTopLevelArgs(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr: string | null = null;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			out.push(body.slice(start, i).trim());
			start = i + 1;
		}
	}
	const tail = body.slice(start).trim();
	if (tail.length > 0) out.push(tail);
	return out;
}

/** Split top-level key:value pairs inside an object literal (curly braces stripped). */
export function splitObjectEntries(body: string): string[] {
	return splitTopLevelArgs(body);
}

/** Parse a `<key>:<value>` entry. Key may be identifier or quoted string. */
export function parseEntry(
	entry: string,
): { key: string; value: string } | null {
	let inStr: string | null = null;
	let depth = 0;
	for (let i = 0; i < entry.length; i++) {
		const c = entry[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === ":" && depth === 0) {
			const rawKey = entry.slice(0, i).trim();
			const value = entry.slice(i + 1).trim();
			const key = unquote(rawKey);
			return { key, value };
		}
	}
	return null;
}

function unquote(s: string): string {
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		try {
			return JSON.parse(s.replace(/'/g, '"'));
		} catch {
			return s.slice(1, -1);
		}
	}
	return s;
}

// ---------------------------------------------------------------------------
// 3. Top-level definition index — maps `<name> = <expr>` for resolution.
// ---------------------------------------------------------------------------

export interface DefinitionIndex {
	/** Bundle source. */
	source: string;
	/** Maps symbol name → expression text (right-hand side of the assignment). */
	defs: Map<string, string>;
	/** Detected Zod alias (e.g. "E" or "I" or "y"). */
	zodAlias: string;
	/** Detected lazy-wrapper helper (e.g. "CH" or "xH" — `<name>(()=>...)`). */
	lazyWrapper: string;
	/**
	 * Maps symbol name → array-literal text for plain `<name>=[...]`
	 * declarations. Claude Code declares reusable enum value lists this way
	 * (e.g. `ev=["PreToolUse",…]`, `DLq=["bash","powershell"]`) and references
	 * them as `y.enum(ev)`. Indexed so the walker can resolve the identifier
	 * argument to a concrete `enum` instead of degrading to `{}`.
	 */
	arrays: Map<string, string>;
}

/**
 * Build an index of `<name>=<expr>` assignments where <expr> looks like a Zod
 * schema factory: `CH(()=>...)`, `E.object({...})`, `E.union([...])`, etc.
 *
 * The bundle minifier emits a flat sequence of `var/let` declarations and the
 * factories are wrapped in a lazy `CH(()=>...)` helper. We scan the entire
 * source for `<ident>=` followed by recognized Zod-ish RHS expressions and
 * record their text spans.
 */
export function indexDefinitions(source: string): DefinitionIndex {
	const defs = new Map<string, string>();
	const zodAlias = detectZodAlias(source);
	const lazyWrapper = detectLazyWrapper(source, zodAlias);
	const factoryStarts = [
		`${lazyWrapper}(()=>`,
		// Bare arrow-function schema factories — `<name>=()=><alias>.<method>(…)`.
		// Claude Code declares small reusable validators this way (e.g.
		// `cFH=()=>y.union([…])`, `z36=()=>y.union([…])`). Indexing them lets
		// `<name>()` field references resolve to a real schema instead of
		// degrading to `{}` — a strict improvement, since unresolved refs still
		// fall back to permissive `{}`.
		`()=>${zodAlias}.object({`,
		`()=>${zodAlias}.strictObject({`,
		`()=>${zodAlias}.union([`,
		`()=>${zodAlias}.discriminatedUnion(`,
		`()=>${zodAlias}.lazy(`,
		`${zodAlias}.object({`,
		`${zodAlias}.strictObject({`,
		`${zodAlias}.union([`,
		`${zodAlias}.discriminatedUnion(`,
		`${zodAlias}.lazy(`,
	];
	// Walk every "=<factory>" occurrence and grab the preceding identifier.
	for (const start of factoryStarts) {
		let pos = 0;
		while (true) {
			const idx = source.indexOf(start, pos);
			if (idx === -1) break;
			pos = idx + 1;
			// preceding char must be '='
			if (source[idx - 1] !== "=") continue;
			// walk back through the identifier
			let nameEnd = idx - 1;
			let nameStart = nameEnd;
			while (
				nameStart > 0 &&
				/[\w$]/.test(source[nameStart - 1])
			)
				nameStart--;
			if (nameStart === nameEnd) continue;
			const name = source.slice(nameStart, nameEnd);
			if (defs.has(name)) continue;
			// extract the RHS expression text
			const expr = extractExpression(source, idx);
			if (expr) defs.set(name, expr);
		}
	}

	// Index plain `<name>=[...]` array-literal declarations whose elements are
	// all string literals. These back `y.enum(<name>)` references (e.g. the
	// hook-event list `ev`, the shell list `DLq`). Only string-of-strings
	// arrays are indexed — that is all `y.enum(...)` ever consumes.
	const arrays = new Map<string, string>();
	const arrRe = /(?:^|[;,{(\s])([A-Za-z_$][\w$]*)=\[/g;
	let am: RegExpExecArray | null;
	while ((am = arrRe.exec(source)) !== null) {
		const name = am[1];
		if (arrays.has(name)) continue;
		const bracketIdx = source.indexOf("[", am.index);
		const arr = extractBalanced(source, bracketIdx, "[", "]");
		if (!arr) continue;
		const inner = arr.slice(1, -1).trim();
		if (inner.length === 0) continue;
		const parts = splitTopLevelArgs(inner);
		// All elements must be plain string literals — anything else means this
		// isn't an enum value list and resolving it could mislead the walker.
		const allStrings = parts.every(
			(p) =>
				(p.startsWith('"') && p.endsWith('"')) ||
				(p.startsWith("'") && p.endsWith("'")),
		);
		if (allStrings) arrays.set(name, arr);
	}

	return { source, defs, zodAlias, lazyWrapper, arrays };
}

/**
 * Detect the lazy-wrapper helper used to wrap Zod schemas — `<wrapper>(()=>...)`.
 *
 * The bundle also contains a generic module-factory helper (often `T(()=>{...})`
 * for Bun-compiled CJS modules) that uses the same pattern but isn't related
 * to Zod. We disambiguate by requiring the arrow body to start with the Zod
 * alias call: `<wrapper>(()=><zodAlias>.<method>`.
 */
function detectLazyWrapper(source: string, zodAlias: string): string {
	const counts = new Map<string, number>();
	const re = new RegExp(
		`\\b([A-Za-z_$][\\w$]*)\\(\\(\\)=>${zodAlias.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\.`,
		"g",
	);
	let m;
	while ((m = re.exec(source)) !== null) {
		const name = m[1];
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	let best = "CH";
	let bestN = 0;
	for (const [name, n] of counts) {
		if (n > bestN) {
			bestN = n;
			best = name;
		}
	}
	return best;
}

/**
 * Extract the RHS expression starting at exprStart. The expression continues
 * through balanced parens/brackets/braces and method-chain calls until we hit
 * a separator at depth 0 (',', ';', or newline outside of literals).
 */
function extractExpression(src: string, exprStart: number): string {
	let depth = 0;
	let inStr: string | null = null;
	for (let i = exprStart; i < src.length; i++) {
		const c = src[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) return src.slice(exprStart, i);
			depth--;
		} else if (depth === 0 && (c === "," || c === ";")) {
			return src.slice(exprStart, i);
		}
	}
	return src.slice(exprStart);
}

function detectZodAlias(source: string): string {
	// Find the most common alias used for .object({...}).
	const candidates = new Map<string, number>();
	const re = /\b([A-Za-z_$])\.object\(\{/g;
	let m;
	while ((m = re.exec(source)) !== null) {
		candidates.set(m[1], (candidates.get(m[1]) ?? 0) + 1);
	}
	let best = "E";
	let bestN = 0;
	for (const [alias, n] of candidates) {
		if (n > bestN) {
			bestN = n;
			best = alias;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// 4. Master schema locator
// ---------------------------------------------------------------------------

/**
 * Find the plugin.json master schema by anchoring on `.strict().safeParse(`
 * adjacent to the "kebab-case" error string. The master schema's symbol name
 * appears immediately before that .strict() chain.
 */
export function findMasterSchemaName(index: DefinitionIndex): string | null {
	const { source } = index;
	const anchor = "is not kebab-case";
	const anchorIdx = source.indexOf(anchor);
	if (anchorIdx === -1) return null;
	// Search backwards for the nearest ".strict().safeParse(" call.
	const search = source.slice(Math.max(0, anchorIdx - 4000), anchorIdx);
	const callIdx = search.lastIndexOf(".strict().safeParse(");
	if (callIdx === -1) return null;
	const absoluteCallIdx = Math.max(0, anchorIdx - 4000) + callIdx;
	// Walk back across `().` to find the symbol name.
	let i = absoluteCallIdx - 1;
	// expect pattern: <name>()
	if (source.slice(i - 1, i + 1) !== "()") return null;
	let nameEnd = i - 1;
	let nameStart = nameEnd;
	while (nameStart > 0 && /[\w$]/.test(source[nameStart - 1])) nameStart--;
	if (nameStart === nameEnd) return null;
	return source.slice(nameStart, nameEnd);
}

// ---------------------------------------------------------------------------
// 5. Master schema spread parser
// ---------------------------------------------------------------------------

export interface SpreadRef {
	name: string;
	partial: boolean;
}

/**
 * Parse `E.object({...subA().shape, ...subB().partial().shape})` into the list
 * of sub-schema references with their partial flag.
 */
export function parseMasterSpread(
	expr: string,
	zodAlias: string,
	lazyWrapper = "CH",
): SpreadRef[] {
	// Strip the `<lazyWrapper>(()=>...)` wrapper if present.
	let body = expr;
	const wrapperPrefix = `${lazyWrapper}(()=>`;
	if (body.startsWith(wrapperPrefix)) {
		// The opening `(` of the wrapper sits right after the identifier.
		const inner = extractBalanced(body, lazyWrapper.length, "(", ")");
		body = inner.slice(1, -1); // strip outer parens
		body = body.replace(/^\(\)=>/, "");
	}
	// Expect E.object({...})
	const objStart = body.indexOf(`${zodAlias}.object(`);
	if (objStart === -1) return [];
	const parenBlock = extractBalanced(
		body,
		objStart + `${zodAlias}.object`.length,
		"(",
		")",
	);
	const objLiteral = parenBlock.slice(1, -1); // strip outer parens
	if (!objLiteral.startsWith("{") || !objLiteral.endsWith("}")) return [];
	const inner = objLiteral.slice(1, -1);
	const entries = splitObjectEntries(inner);
	const refs: SpreadRef[] = [];
	for (const e of entries) {
		// pattern: ...<name>()(.partial())?.shape
		const m = e.match(/^\.\.\.([\w$]+)\(\)(\.partial\(\))?\.shape$/);
		if (m) refs.push({ name: m[1], partial: !!m[2] });
	}
	return refs;
}

// ---------------------------------------------------------------------------
// 6. Zod → JSON Schema evaluator
// ---------------------------------------------------------------------------

export type JSONSchema = Record<string, unknown>;

interface EvalContext {
	index: DefinitionIndex;
	resolving: Set<string>; // cycle guard
	/**
	 * Locally-scoped schema expressions, e.g. the `let{A:H,…}=Np9()`
	 * destructuring inside a block-body arrow factory. `evalHead` consults this
	 * map before treating a bare `<ident>` as a top-level definition. Optional —
	 * absent at the top level.
	 */
	bindings?: Map<string, string>;
}

/**
 * Translate a Zod expression to JSON Schema. Unknown/unsupported patterns fall
 * back to `{}` (permissive). The evaluator is intentionally lenient — false
 * negatives are better than false positives in a linter.
 */
export function evalZod(expr: string, ctx: EvalContext): JSONSchema {
	expr = expr.trim();

	// Strip the detected lazy wrapper, e.g. `CH(()=>X)` or `xH(()=>X)`.
	const lazyPrefix = `${ctx.index.lazyWrapper}(()=>`;
	if (expr.startsWith(lazyPrefix)) {
		const wrapped = extractBalanced(
			expr,
			ctx.index.lazyWrapper.length,
			"(",
			")",
		);
		const inner = wrapped.slice(1, -1).replace(/^\(\)=>/, "");
		return evalZod(inner, ctx);
	}
	// Strip a bare arrow-function schema factory: `()=><ZodExpr>`. Claude Code
	// declares reusable validators as `<name>=()=>y.union([…])`; indexed by
	// name, their RHS keeps the `()=>` prefix that must be peeled before eval.
	if (expr.startsWith("()=>")) {
		return evalZod(expr.slice(4), ctx);
	}

	// Block-body arrow factory: `{ let{A:H,…}=<Fn>(); return <ZodExpr> }`.
	// Claude Code's hook-entry validator is declared this way — it destructures
	// a bundle of named sub-schemas out of a helper function and then composes
	// them into a discriminatedUnion. We resolve the helper's returned object
	// literal, bind each destructured name to its schema expression, and
	// evaluate the `return` expression with those local bindings in scope.
	if (expr.startsWith("{") && extractBalanced(expr, 0, "{", "}") === expr) {
		const blockSchema = evalBlockBody(expr, ctx);
		if (blockSchema) return blockSchema;
		return {};
	}

	// Strip plain (X) wrapping.
	if (expr.startsWith("(") && extractBalanced(expr, 0, "(", ")") === expr) {
		return evalZod(expr.slice(1, -1), ctx);
	}

	// Resolve a method chain by reading the head term and then folding modifiers.
	const chain = splitChain(expr);
	if (chain.length === 0) return {};

	let schema: JSONSchema = evalHead(chain[0], ctx);
	for (let i = 1; i < chain.length; i++) {
		schema = applyMethod(schema, chain[i], ctx);
	}
	return schema;
}

/**
 * Evaluate a block-body arrow factory:
 *   `{ let{Key1:H,Key2:$,…}=<Fn>(); return <ZodExpr> }`
 *
 * Claude Code's hook-entry schema (`XLq`) is declared exactly this way: it
 * destructures a bundle of named sub-schemas out of a plain helper function
 * (`Np9`) — itself `function Np9(){ let H=y.object({…}),…; return {Key1:H,…} }`
 * — and composes them into a `discriminatedUnion`. The generic chain evaluator
 * cannot follow this, so we special-case it:
 *
 *   1. Parse the `let{…}=<Fn>()` destructuring → `{ localName → returnKey }`.
 *   2. Locate `function <Fn>()`, extract its returned object literal, and map
 *      each `returnKey → schemaExpr`.
 *   3. Bind every destructured local name to its schema expression and
 *      evaluate the `return` expression with those bindings in scope.
 *
 * Returns null when the body does not match this shape — the caller then
 * degrades to permissive `{}`, never a false positive.
 */
function evalBlockBody(block: string, ctx: EvalContext): JSONSchema | null {
	const inner = block.slice(1, -1);
	// `return <expr>` — capture the trailing return expression.
	const retIdx = inner.search(/\breturn\b/);
	if (retIdx === -1) return null;
	let retExpr = inner.slice(retIdx + "return".length).trim();
	if (retExpr.endsWith(";")) retExpr = retExpr.slice(0, -1).trim();

	const bindings = new Map<string, string>(ctx.bindings ?? []);

	// Parse `let{A:H,B:$,…}=<Fn>()` destructuring assignments in the prelude.
	const prelude = inner.slice(0, retIdx);
	const destructRe = /\{([^{}]*)\}=([\w$]+)\(\)/g;
	let dm: RegExpExecArray | null;
	while ((dm = destructRe.exec(prelude)) !== null) {
		const pairs = dm[1];
		const fnName = dm[2];
		const returned = evalFunctionReturnObject(fnName, ctx);
		if (!returned) continue;
		for (const part of splitTopLevelArgs(pairs)) {
			const entry = parseEntry(part);
			// `{Key:local}` → bind `local`; `{Key}` shorthand → bind `Key`.
			const returnKey = entry ? entry.key : part.trim();
			const localName = entry ? entry.value.trim() : part.trim();
			const schemaExpr = returned.get(returnKey);
			if (schemaExpr) bindings.set(localName, schemaExpr);
		}
	}

	if (bindings.size === 0) return null;
	return evalZod(retExpr, { ...ctx, bindings });
}

/**
 * Locate `function <name>(){…}` and parse its returned object literal into a
 * `key → schemaExpr` map. The helper declares each schema as a `let`/`var`
 * binding and returns `{Key1:local1,Key2:local2,…}`; we resolve those local
 * names back to their declared expressions so each key maps to a real schema.
 */
function evalFunctionReturnObject(
	fnName: string,
	ctx: EvalContext,
): Map<string, string> | null {
	const { source } = ctx.index;
	const fnIdx = source.indexOf(`function ${fnName}(`);
	if (fnIdx === -1) return null;
	const braceIdx = source.indexOf("{", fnIdx);
	if (braceIdx === -1) return null;
	const body = extractBalanced(source, braceIdx, "{", "}");
	if (!body) return null;
	const fnInner = body.slice(1, -1);

	const retIdx = fnInner.lastIndexOf("return{");
	if (retIdx === -1) return null;
	const retObj = extractBalanced(
		fnInner,
		fnInner.indexOf("{", retIdx),
		"{",
		"}",
	);
	if (!retObj) return null;

	// Collect the helper's local `let`/`var`/`const` declarations:
	// `H=y.object({…})`, `$=y.object({…})`, … The prelude is everything before
	// the return; declarations are comma- or `let`-separated assignments.
	const prelude = fnInner.slice(0, retIdx);
	const localDefs = new Map<string, string>();
	const declRe = /(?:^|[;,]|\blet |\bvar |\bconst )([A-Za-z_$][\w$]*)=/g;
	let dm: RegExpExecArray | null;
	while ((dm = declRe.exec(prelude)) !== null) {
		const name = dm[1];
		if (localDefs.has(name)) continue;
		const valStart = declRe.lastIndex;
		const expr = extractExpression(prelude, valStart);
		if (expr) localDefs.set(name, expr);
	}

	// Map each returned `Key:local` (or `{Key}` shorthand) to its schema expr.
	const out = new Map<string, string>();
	for (const part of splitTopLevelArgs(retObj.slice(1, -1))) {
		const entry = parseEntry(part);
		const key = entry ? entry.key : part.trim();
		const localName = entry ? entry.value.trim() : part.trim();
		const schemaExpr = localDefs.get(localName) ?? localName;
		out.set(key, schemaExpr);
	}
	return out.size > 0 ? out : null;
}

/**
 * Split `E.object({...}).optional().describe(...)` into
 *   ["E.object({...})", "optional()", "describe(...)"].
 *
 * Only splits on `.` that appears after a `)` or `]` at depth 0 — this keeps
 * the head call (`E.object({...})` or `<ident>()`) intact while peeling off
 * subsequent method chain steps.
 */
export function splitChain(expr: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr: string | null = null;
	let start = 0;
	let prev = "";
	for (let i = 0; i < expr.length; i++) {
		const c = expr[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			prev = c;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			prev = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (
			c === "." &&
			depth === 0 &&
			(prev === ")" || prev === "]")
		) {
			out.push(expr.slice(start, i));
			start = i + 1;
		}
		prev = c;
	}
	out.push(expr.slice(start));
	return out;
}

function evalHead(head: string, ctx: EvalContext): JSONSchema {
	const { zodAlias, defs } = ctx.index;
	head = head.trim();

	// Resolve a locally-bound identifier (block-body `let{…}=Fn()` destructure).
	// These appear bare — `[H,$,q,K,_]` inside a discriminatedUnion array — not
	// as `H()` calls, so the bare-identifier case is checked first.
	if (ctx.bindings) {
		const bareId = head.match(/^([\w$]+)$/);
		if (bareId) {
			const bound = ctx.bindings.get(bareId[1]);
			if (bound !== undefined && !ctx.resolving.has(bareId[1])) {
				ctx.resolving.add(bareId[1]);
				try {
					return evalZod(bound, ctx);
				} finally {
					ctx.resolving.delete(bareId[1]);
				}
			}
		}
	}

	// Resolve identifier()  →  follow definition.
	const idCall = head.match(/^([\w$]+)\(\)$/);
	if (idCall && idCall[1] !== zodAlias) {
		const name = idCall[1];
		if (ctx.resolving.has(name)) return {}; // cycle
		// A locally-bound name may be called as `<name>()` too.
		const localBound = ctx.bindings?.get(name);
		const def = localBound ?? defs.get(name);
		if (!def) return {};
		ctx.resolving.add(name);
		try {
			return evalZod(def, ctx);
		} finally {
			ctx.resolving.delete(name);
		}
	}

	// E.<method>(...args)
	if (head.startsWith(`${zodAlias}.`)) {
		const rest = head.slice(zodAlias.length + 1);
		const callMatch = rest.match(/^([\w$]+)/);
		if (!callMatch) return {};
		const method = callMatch[1];
		const argsBody =
			head[zodAlias.length + 1 + method.length] === "("
				? extractBalanced(
						head,
						zodAlias.length + 1 + method.length,
						"(",
						")",
					).slice(1, -1)
				: "";
		return evalZodPrimitive(method, argsBody, ctx);
	}

	return {};
}

function evalZodPrimitive(
	method: string,
	argsBody: string,
	ctx: EvalContext,
): JSONSchema {
	const args = argsBody.length > 0 ? splitTopLevelArgs(argsBody) : [];
	switch (method) {
		case "string":
			return { type: "string" };
		case "number":
		case "bigint":
			return { type: "number" };
		case "boolean":
			return { type: "boolean" };
		case "null":
			return { type: "null" };
		case "undefined":
		case "void":
			return { not: {} };
		case "any":
		case "unknown":
			return {};
		case "never":
			return { not: {} };
		case "literal": {
			if (args.length === 0) return {};
			return { const: evalLiteralValue(args[0]) };
		}
		case "enum":
		case "nativeEnum": {
			if (args.length === 0) return {};
			let arrBody = args[0].trim();
			// `y.enum(<ident>)` — resolve the identifier to its indexed
			// array-literal definition (e.g. `y.enum(ev)`).
			if (!arrBody.startsWith("[")) {
				const idMatch = arrBody.match(/^([\w$]+)$/);
				if (idMatch) {
					const resolved = ctx.index.arrays.get(idMatch[1]);
					if (resolved) arrBody = resolved;
				}
			}
			if (arrBody.startsWith("[") && arrBody.endsWith("]")) {
				const vals = splitTopLevelArgs(arrBody.slice(1, -1)).map(
					evalLiteralValue,
				);
				return { enum: vals };
			}
			return {};
		}
		case "array": {
			if (args.length === 0) return { type: "array" };
			return { type: "array", items: evalZod(args[0], ctx) };
		}
		case "tuple": {
			if (args.length === 0) return { type: "array" };
			const arr = args[0];
			if (arr.startsWith("[") && arr.endsWith("]")) {
				const items = splitTopLevelArgs(arr.slice(1, -1)).map((e) =>
					evalZod(e, ctx),
				);
				return { type: "array", prefixItems: items, items: false };
			}
			return { type: "array" };
		}
		case "object": {
			if (args.length === 0) return { type: "object" };
			return evalZodObject(args[0], ctx, /*strict*/ false);
		}
		case "strictObject": {
			if (args.length === 0) return { type: "object" };
			return evalZodObject(args[0], ctx, /*strict*/ true);
		}
		case "looseObject":
		case "passthrough": {
			if (args.length === 0) return { type: "object" };
			const obj = evalZodObject(args[0], ctx, /*strict*/ false);
			return { ...obj, additionalProperties: true };
		}
		case "record":
		case "partialRecord": {
			if (args.length === 0)
				return { type: "object", additionalProperties: {} };
			// Two forms: record(V) or record(K, V). We only need V
			// (additionalProperties). `partialRecord` differs from `record` only
			// in that every key is optional — JSON Schema records have no
			// required keys anyway, so the two map to the same shape.
			const valueExpr = args.length === 1 ? args[0] : args[1];
			return { type: "object", additionalProperties: evalZod(valueExpr, ctx) };
		}
		case "union": {
			if (args.length === 0) return {};
			const arr = args[0];
			if (arr.startsWith("[") && arr.endsWith("]")) {
				const branches = splitTopLevelArgs(arr.slice(1, -1)).map((e) =>
					evalZod(e, ctx),
				);
				return { anyOf: branches };
			}
			return {};
		}
		case "discriminatedUnion": {
			// (discriminatorKey, [branches])
			if (args.length < 2) return {};
			const arr = args[1];
			if (arr.startsWith("[") && arr.endsWith("]")) {
				const branches = splitTopLevelArgs(arr.slice(1, -1)).map((e) =>
					evalZod(e, ctx),
				);
				return { oneOf: branches };
			}
			return {};
		}
		case "intersection": {
			if (args.length < 2) return {};
			return { allOf: [evalZod(args[0], ctx), evalZod(args[1], ctx)] };
		}
		case "lazy": {
			// lazy(() => X) — strip arrow function wrapper, eval body.
			if (args.length === 0) return {};
			let body = args[0].trim();
			body = body.replace(/^\(\)=>/, "");
			return evalZod(body, ctx);
		}
		case "preprocess": {
			// preprocess(transformFn, innerSchema) — transformFn coerces input;
			// innerSchema is what actually gets validated. We only care about
			// the post-transform schema for static checking.
			if (args.length < 2) return {};
			return evalZod(args[1], ctx);
		}
		default:
			return {};
	}
}

/** Parse a Zod object body `{key: zodExpr, ...spread, ...}` into JSON Schema. */
function evalZodObject(
	objLiteral: string,
	ctx: EvalContext,
	strict: boolean,
): JSONSchema {
	if (!objLiteral.startsWith("{") || !objLiteral.endsWith("}"))
		return { type: "object" };
	const inner = objLiteral.slice(1, -1);
	const entries = splitObjectEntries(inner);
	const props: Record<string, JSONSchema> = {};
	const required: string[] = [];

	for (const e of entries) {
		// Spread: `...<expr>.shape` (Zod's way to merge another schema's keys).
		// We re-evaluate the spread source and merge its properties+required in.
		const spreadMatch = e.match(/^\.\.\.(.+?)(?:\.shape)?$/);
		if (e.startsWith("...") && spreadMatch) {
			const subExpr = spreadMatch[1];
			const sub = evalZod(subExpr, ctx);
			const subProps = (sub.properties as Record<string, JSONSchema>) ?? {};
			for (const [k, v] of Object.entries(subProps)) {
				props[k] = v;
			}
			const subReq = (sub.required as string[]) ?? [];
			for (const r of subReq) required.push(r);
			continue;
		}

		const parsed = parseEntry(e);
		if (!parsed) continue;
		const { key, value } = parsed;
		const valueSchema = evalZod(value, ctx);
		props[key] = valueSchema;
		if (!isOptional(value, ctx)) required.push(key);
	}

	const out: JSONSchema = { type: "object", properties: props };
	if (required.length > 0) out.required = [...new Set(required)];
	if (strict) out.additionalProperties = false;
	return out;
}

/**
 * Detect whether a Zod object-field value expression is optional.
 *
 * Checks the literal chain for `.optional()` / `.nullish()` / `.default()`,
 * and — when `ctx` is supplied — follows bare identifier references
 * (`Zp9()`, `CH(()=>...)` aliases) into their definitions. A field whose
 * value is a reference to a schema that is itself `.optional()` (e.g.
 * `network:Zp9()` where `Zp9 = SH(()=>y.object({...}).optional())`) must NOT
 * be treated as required. Following references can only *relax*
 * required-ness — the safe direction for a linter that must never
 * over-validate.
 */
function isOptional(expr: string, ctx?: EvalContext, depth = 0): boolean {
	expr = expr.trim();

	// Peel the lazy wrapper, e.g. `SH(()=>X)`, so the inner chain is visible.
	if (ctx) {
		const lazyPrefix = `${ctx.index.lazyWrapper}(()=>`;
		if (expr.startsWith(lazyPrefix)) {
			const wrapped = extractBalanced(
				expr,
				ctx.index.lazyWrapper.length,
				"(",
				")",
			);
			if (wrapped) {
				const inner = wrapped.slice(1, -1).replace(/^\(\)=>/, "");
				return isOptional(inner, ctx, depth);
			}
		}
	}

	// Peel a bare arrow-function factory prefix (`()=><ZodExpr>`) — indexed
	// `<name>=()=>…` defs keep it; the chain after the arrow holds the modifiers.
	if (expr.startsWith("()=>")) {
		return isOptional(expr.slice(4), ctx, depth);
	}

	const chain = splitChain(expr);
	for (const part of chain) {
		if (part.startsWith("optional(")) return true;
		if (part.startsWith("nullish(")) return true;
		if (part.startsWith("default(")) return true;
	}

	// Follow a bare `<ident>()` reference into its definition.
	if (ctx && depth < 8) {
		const head = chain[0]?.trim() ?? "";
		const idCall = head.match(/^([\w$]+)\(\)$/);
		if (idCall && idCall[1] !== ctx.index.zodAlias) {
			const def = ctx.index.defs.get(idCall[1]);
			if (def) return isOptional(def, ctx, depth + 1);
		}
	}
	return false;
}

function evalLiteralValue(expr: string): unknown {
	expr = expr.trim();
	if (expr === "true") return true;
	if (expr === "false") return false;
	if (expr === "null") return null;
	if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
	if (
		(expr.startsWith('"') && expr.endsWith('"')) ||
		(expr.startsWith("'") && expr.endsWith("'"))
	) {
		try {
			return JSON.parse(expr.replace(/^'|'$/g, '"'));
		} catch {
			return expr.slice(1, -1);
		}
	}
	return expr;
}

function applyMethod(
	schema: JSONSchema,
	step: string,
	ctx: EvalContext,
): JSONSchema {
	const callMatch = step.match(/^([\w$]+)\(?/);
	if (!callMatch) return schema;
	const method = callMatch[1];
	const argsBody =
		step[method.length] === "("
			? extractBalanced(step, method.length, "(", ")").slice(1, -1)
			: "";
	const args = argsBody.length > 0 ? splitTopLevelArgs(argsBody) : [];

	switch (method) {
		case "optional":
		case "nullable":
		case "nullish":
		case "describe":
		case "default":
		case "refine":
		case "superRefine":
		case "transform":
		case "pipe":
		case "brand":
		case "readonly":
		case "catch":
			// Mostly transparent for validation purposes. .describe attaches text;
			// .nullable allows null; .default provides fallback. We surface
			// description but otherwise pass-through.
			if (method === "describe" && args.length > 0) {
				const desc = evalLiteralValue(args[0]);
				if (typeof desc === "string") schema = { ...schema, description: desc };
			}
			if (method === "nullable") {
				// allow null in addition to the existing type
				if (schema.type && typeof schema.type === "string") {
					schema = { ...schema, type: [schema.type as string, "null"] };
				} else if (Array.isArray(schema.enum)) {
					// `.nullable()` on a `z.enum([...])` must also admit null —
					// otherwise a legitimate `null` value becomes a false positive.
					const vals = schema.enum as unknown[];
					if (!vals.includes(null)) {
						schema = { ...schema, enum: [...vals, null] };
					}
				}
			}
			if (method === "default" && args.length > 0) {
				schema = { ...schema, default: evalLiteralValue(args[0]) };
			}
			return schema;
		case "min":
			if (schema.type === "string")
				return { ...schema, minLength: Number(args[0] ?? 0) };
			if (schema.type === "array")
				return { ...schema, minItems: Number(args[0] ?? 0) };
			return { ...schema, minimum: Number(args[0] ?? 0) };
		case "max":
			if (schema.type === "string")
				return { ...schema, maxLength: Number(args[0] ?? 0) };
			if (schema.type === "array")
				return { ...schema, maxItems: Number(args[0] ?? 0) };
			return { ...schema, maximum: Number(args[0] ?? 0) };
		case "length":
			if (schema.type === "string") {
				const n = Number(args[0] ?? 0);
				return { ...schema, minLength: n, maxLength: n };
			}
			return schema;
		case "regex":
			if (args.length > 0) {
				const r = args[0].trim();
				const slash = r.match(/^\/(.+)\/([a-z]*)$/);
				if (slash) return { ...schema, pattern: slash[1] };
			}
			return schema;
		case "email":
			return { ...schema, format: "email" };
		case "url":
			return { ...schema, format: "uri" };
		case "uuid":
			return { ...schema, format: "uuid" };
		case "strict":
			return { ...schema, additionalProperties: false };
		case "passthrough":
			return { ...schema, additionalProperties: true };
		case "partial": {
			// Drop the required array on object schemas.
			if (schema.type === "object") {
				const { required: _r, ...rest } = schema as Record<string, unknown>;
				return rest as JSONSchema;
			}
			return schema;
		}
		case "extend":
		case "merge": {
			// Merge another object schema's properties into this one.
			// `.merge(zodSchema)` takes another schema; `.extend({...})` takes a
			// bare shape object literal (`{key: zodExpr, ...}`) — not wrapped in
			// `<alias>.object(...)`. Detect the raw-literal form and evaluate it
			// directly as an object body so the extended fields survive.
			if (args.length === 0) return schema;
			const arg = args[0].trim();
			const other =
				arg.startsWith("{") && arg.endsWith("}")
					? evalZodObject(arg, ctx, /*strict*/ false)
					: evalZod(arg, ctx);
			return mergeObjectSchemas(schema, other);
		}
		case "shape":
			// `.shape` is a property access used in spreads like `X.shape`. When it
			// appears as a method-style step (rare), treat as pass-through.
			return schema;
		case "array":
			return { type: "array", items: schema };
		default:
			return schema;
	}
}

function mergeObjectSchemas(a: JSONSchema, b: JSONSchema): JSONSchema {
	const props = {
		...((a.properties as Record<string, JSONSchema>) ?? {}),
		...((b.properties as Record<string, JSONSchema>) ?? {}),
	};
	const required = [
		...((a.required as string[]) ?? []),
		...((b.required as string[]) ?? []),
	];
	const out: JSONSchema = { type: "object", properties: props };
	if (required.length > 0) out.required = [...new Set(required)];
	return out;
}

// ---------------------------------------------------------------------------
// 7. Compose master schema from sub-schemas
// ---------------------------------------------------------------------------

/**
 * Walk back from an in-source anchor to the nearest `<symbol>=CH(()=>` and
 * return that symbol's name. Used to locate sub-schemas (RSH, vC8, M09, ...)
 * across minifier rotations — anchor text is a stable error message inside
 * the schema's refine/describe call.
 */
export function findSymbolByAnchor(
	index: DefinitionIndex,
	anchorText: string,
): string | null {
	const { source, lazyWrapper } = index;
	const anchorIdx = source.indexOf(anchorText);
	if (anchorIdx === -1) return null;
	const eq = source.lastIndexOf(`=${lazyWrapper}(()=>`, anchorIdx);
	if (eq === -1) return null;
	let nameEnd = eq;
	let nameStart = nameEnd;
	while (nameStart > 0 && /[\w$]/.test(source[nameStart - 1])) nameStart--;
	if (nameStart === nameEnd) return null;
	return source.slice(nameStart, nameEnd);
}

/**
 * Build the `.lsp.json` schema. Shape: record of server-name → RSH (the
 * per-server strict object). Matches Claude Code's runtime validator
 * `E.record(E.string(), RSH()).safeParse(content)`.
 */
export function buildLspSchema(index: DefinitionIndex): JSONSchema | null {
	const rsh = findSymbolByAnchor(
		index,
		"extensionToLanguage must have at least one mapping",
	);
	if (!rsh) return null;
	const def = index.defs.get(rsh);
	if (!def) return null;
	const rshSchema = evalZod(def, { index, resolving: new Set() });
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "Claude Code .lsp.json",
		type: "object",
		additionalProperties: rshSchema,
		description:
			"Flat map of server-name → LSP server config. The top-level keys are server names; their values match the per-server schema. This file is loaded by Claude Code when present at the plugin root.",
	};
}

/**
 * Build the `monitors/monitors.json` schema. Shape: array of M09 entries with
 * a refine() check that all `name` values are unique. The unique-name check
 * can't be expressed in JSON Schema; the monitors-json linter enforces it
 * separately.
 */
export function buildMonitorsSchema(index: DefinitionIndex): JSONSchema | null {
	const vc8 = findSymbolByAnchor(
		index,
		"Monitor names must be unique within a plugin",
	);
	if (!vc8) return null;
	const def = index.defs.get(vc8);
	if (!def) return null;
	const arrSchema = evalZod(def, { index, resolving: new Set() });
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "Claude Code monitors.json",
		...arrSchema,
		description:
			"Array of monitor entries. Each monitor's `name` must be unique within the plugin (Claude Code enforces this with a refine() check that is not expressible in JSON Schema; the monitors-json linter does it separately).",
	};
}

/**
 * Build the `settings.json` schema. Claude Code's settings validator is a
 * function (`QU8(H)`-shaped) that returns `y.object({$schema, apiKeyHelper,
 * ...}).passthrough()`. We anchor on the `$schema` field's stable describe
 * string ("JSON Schema reference for Claude Code settings"), locate the
 * enclosing `<alias>.object({...})` call, and evaluate the whole chain
 * (including the trailing `.passthrough()`).
 *
 * CRITICAL: this schema is NOT `.strict()` — it is passthrough. The emitted
 * JSON Schema MUST keep `additionalProperties` permissive so unknown
 * top-level keys never become schema errors (the advisory
 * `settings-json/no-unknown-fields` rule covers those). The trailing
 * `.passthrough()` in the source sets `additionalProperties: true`; we also
 * defensively strip a `false` value if extraction ever produced one.
 *
 * Several spreads in the source (`...hLq(H)` plugin-contributed extensions,
 * `...mH(env)&&{xaaIdp:...}` feature-flag-gated fields, `...!1` no-ops) do not
 * resolve statically — the walker degrades them to `{}` and drops them, which
 * is correct: under-validation is the safe failure mode.
 */
export function buildSettingsSchema(index: DefinitionIndex): JSONSchema | null {
	const { source, zodAlias } = index;
	const anchor = "JSON Schema reference for Claude Code settings";
	// Prefer the last occurrence — the bundle embeds the describe string twice
	// (once in a metadata table, once in the actual schema source).
	let anchorIdx = source.lastIndexOf(anchor);
	if (anchorIdx === -1) return null;

	// Walk back to the nearest `<alias>.object(` that encloses this anchor.
	const objMarker = `${zodAlias}.object(`;
	let objIdx = -1;
	for (;;) {
		const cand = source.lastIndexOf(objMarker, anchorIdx);
		if (cand === -1) return null;
		const block = extractBalanced(
			source,
			cand + `${zodAlias}.object`.length,
			"(",
			")",
		);
		if (block && cand + `${zodAlias}.object`.length + block.length > anchorIdx) {
			objIdx = cand;
			break;
		}
		anchorIdx = cand - 1;
		if (anchorIdx < 0) return null;
	}

	// Capture the full method chain: `<alias>.object({...}).passthrough()` etc.
	const headStart = objIdx;
	let exprEnd = objIdx + `${zodAlias}.object`.length;
	const parenBlock = extractBalanced(source, exprEnd, "(", ")");
	if (!parenBlock) return null;
	exprEnd += parenBlock.length;
	// Fold trailing `.method(...)` chain steps into the expression.
	while (source[exprEnd] === ".") {
		const m = /^\.[\w$]+/.exec(source.slice(exprEnd));
		if (!m) break;
		let stepEnd = exprEnd + m[0].length;
		if (source[stepEnd] === "(") {
			const argBlock = extractBalanced(source, stepEnd, "(", ")");
			if (!argBlock) break;
			stepEnd += argBlock.length;
		}
		exprEnd = stepEnd;
	}

	const expr = source.slice(headStart, exprEnd);
	const schema = evalZod(expr, { index, resolving: new Set() });

	if (schema.type !== "object") return null;
	// Safety: the settings schema must never reject unknown top-level keys.
	if (schema.additionalProperties === false) {
		delete (schema as Record<string, unknown>).additionalProperties;
	}

	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "Claude Code settings.json",
		...schema,
		description:
			"Claude Code settings.json / settings.local.json. Validates the structure of known fields; the top level is intentionally permissive (Claude Code's validator uses .passthrough()), so unknown top-level keys are not schema errors — the advisory settings-json/no-unknown-fields rule reports those separately.",
	};
}

/**
 * Resolve a markdown-frontmatter Zod object by anchor and emit a permissive
 * JSON Schema. Claude Code's frontmatter validators are `<sym>=SH(()=>y.object(
 * {...}))` definitions; `findSymbolByAnchor` walks back from a stable describe
 * string to the enclosing `=<lazyWrapper>(()=>` and returns `<sym>`.
 *
 * CRITICAL: `additionalProperties` must stay permissive. Although Claude Code
 * applies `.strict()` to the *parse-time* variant (`Q8_.skill`/`Q8_.agent`),
 * an unknown frontmatter key still loads the file — Claude Code only logs a
 * `tengu_frontmatter_shadow_unknown_key` telemetry event, never rejects. The
 * advisory `<artifact>/no-unknown-frontmatter` rules own unknown keys; this
 * schema must never turn them into errors. We anchor on the base (non-strict)
 * symbol and defensively strip any `additionalProperties:false` the walker
 * might emit.
 */
function buildFrontmatterSchema(
	index: DefinitionIndex,
	anchor: string,
	title: string,
	description: string,
): JSONSchema | null {
	const sym = findSymbolByAnchor(index, anchor);
	if (!sym) return null;
	const def = index.defs.get(sym);
	if (!def) return null;
	const schema = evalZod(def, { index, resolving: new Set() });
	if (schema.type !== "object") return null;
	// Safety: never reject unknown frontmatter keys — that is the advisory
	// no-unknown-frontmatter rule's job.
	if (schema.additionalProperties === false) {
		delete (schema as Record<string, unknown>).additionalProperties;
	}
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title,
		...schema,
		description,
	};
}

/**
 * Build the SKILL.md frontmatter schema. Claude Code's skill frontmatter is
 * `Y36 = SH(()=>p8_().extend({...}))` — the base command shape (`p8_`) plus
 * skill-only fields (`when_to_use`, `paths`, `hooks`, `context`, `agent`, …).
 * We anchor on the `when_to_use` field's describe string, which is unique to
 * the skill `.extend(...)` body.
 */
export function buildSkillFrontmatterSchema(
	index: DefinitionIndex,
): JSONSchema | null {
	return buildFrontmatterSchema(
		index,
		"Guidance for when the model should reach for this skill.",
		"Claude Code SKILL.md frontmatter",
		"Claude Code SKILL.md YAML frontmatter. Validates the structure of known fields; the object is intentionally permissive — unknown frontmatter keys are not schema errors (Claude Code still loads the skill), they are reported by the advisory skill-md/no-unknown-frontmatter rule.",
	);
}

/**
 * Build the agent `.md` frontmatter schema. Claude Code's agent frontmatter is
 * `U8_ = SH(()=>y.object({name, description, model, tools, …, permissionMode,
 * …}))`. We anchor on `permissionMode`'s describe string ("Permission mode the
 * agent runs in.") — unique to the agent object.
 */
export function buildAgentFrontmatterSchema(
	index: DefinitionIndex,
): JSONSchema | null {
	return buildFrontmatterSchema(
		index,
		"Permission mode the agent runs in.",
		"Claude Code agent .md frontmatter",
		"Claude Code agent .md YAML frontmatter. Validates the structure of known fields; the object is intentionally permissive — unknown frontmatter keys are not schema errors (Claude Code still loads the agent), they are reported by the advisory agent-md/no-unknown-frontmatter rule.",
	);
}

/**
 * Build the command `.md` frontmatter schema. Claude Code uses a single base
 * frontmatter shape (`p8_`) for slash commands: `name`, `description`, `model`,
 * `allowed-tools`, `argument-hint`, `disable-model-invocation`, etc. (the skill
 * schema `Y36` is this shape `.extend(...)`-ed). We anchor on the
 * `disable-model-invocation` field's describe string, which lives in `p8_`.
 */
export function buildCommandFrontmatterSchema(
	index: DefinitionIndex,
): JSONSchema | null {
	return buildFrontmatterSchema(
		index,
		"If true, the model cannot invoke this via the Skill tool; only users can type the slash command.",
		"Claude Code command .md frontmatter",
		"Claude Code slash-command .md YAML frontmatter. Validates the structure of known fields; the object is intentionally permissive — unknown frontmatter keys are not schema errors (Claude Code still loads the command), they are reported by the advisory command-md/no-unknown-frontmatter rule.",
	);
}

/**
 * Build the `.mcp.json` / `mcp.json` schema. Claude Code's config validator is
 *   `lcA = SH(()=>y.object({mcpServers:y.record(y.string(), aa())}))`
 * where `aa` is the discriminated server-config union
 *   `aa = SH(()=>y.union([K4$(),vU8(),kU8(),NU8(),Sx$(),EU8(),yU8(),SU8()]))`
 * — stdio / sse / sse-ide / ws-ide / http+streamable-http / ws / sdk /
 * claudeai-proxy. (`extract-contracts.ts`'s `extractMcpServerFields` locates
 * the per-transport object via the `type:<alias>.literal("stdio")` anchor; we
 * locate the whole config object instead.)
 *
 * We anchor on the literal source of the `mcpServers` record declaration —
 * `mcpServers:<alias>.record(<alias>.string(),` — walk back to the enclosing
 * `<alias>.object(`, and evaluate the whole expression. The server union has
 * no `.strict()`, so unknown server fields stay the advisory
 * `mcp-json/no-unknown-server-fields` rule's job; we defensively strip any
 * `additionalProperties:false` the walker might emit.
 */
export function buildMcpJsonSchema(index: DefinitionIndex): JSONSchema | null {
	const { source, zodAlias } = index;
	const anchor = `mcpServers:${zodAlias}.record(${zodAlias}.string(),`;
	const anchorIdx = source.indexOf(anchor);
	if (anchorIdx === -1) return null;

	// Walk back to the nearest `<alias>.object(` whose balanced body encloses
	// the anchor.
	const objMarker = `${zodAlias}.object(`;
	let objIdx = -1;
	let searchFrom = anchorIdx;
	for (;;) {
		const cand = source.lastIndexOf(objMarker, searchFrom);
		if (cand === -1) return null;
		const block = extractBalanced(
			source,
			cand + `${zodAlias}.object`.length,
			"(",
			")",
		);
		if (
			block &&
			cand + `${zodAlias}.object`.length + block.length > anchorIdx
		) {
			objIdx = cand;
			break;
		}
		searchFrom = cand - 1;
		if (searchFrom < 0) return null;
	}

	const parenBlock = extractBalanced(
		source,
		objIdx + `${zodAlias}.object`.length,
		"(",
		")",
	);
	if (!parenBlock) return null;
	const expr = source.slice(objIdx, objIdx + `${zodAlias}.object`.length) +
		parenBlock;
	const schema = evalZod(expr, { index, resolving: new Set() });
	if (schema.type !== "object") return null;
	if (schema.additionalProperties === false) {
		delete (schema as Record<string, unknown>).additionalProperties;
	}
	stripAdditionalPropertiesFalse(schema);
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "Claude Code .mcp.json",
		...schema,
		description:
			"Claude Code .mcp.json / mcp.json. The single `mcpServers` key maps server names to per-server transport configs (stdio / sse / http / streamable-http / …). Validates the structure of known fields; unknown server fields are not schema errors — the advisory mcp-json/no-unknown-server-fields rule reports those.",
	};
}

/**
 * Build the `hooks/hooks.json` schema. Claude Code has no standalone
 * `{hooks:…}` validator — the hooks block is always nested inside
 * `settings.json` as `hooks:HC()`. `hooks.json` is that same block lifted to a
 * file, so the schema is `{ hooks: <HC> }`.
 *
 * `HC` is the hooks-config validator:
 *   `HC = SH(()=>y.partialRecord(y.enum(ev), y.array(LLq())))`
 * — a map of hook-event name (`ev` = PreToolUse / PostToolUse / …) to an array
 * of `LLq` matcher entries `{matcher?:string, hooks:array(XLq())}`. `XLq` is
 * the per-hook discriminated union (`command` / `prompt` / `http` / `agent` /
 * `mcp_tool`), declared as a block-body factory the walker now resolves.
 *
 * We anchor on `XLq`'s `=<lazyWrapper>(()=>{` declaration (the block-body form
 * is unique to the hook-entry schema) and walk up the reference chain
 * XLq → LLq → HC by symbol name. The hook objects are plain `y.object(...)`
 * (not `.strict()`), so unknown hook fields stay permissive.
 */
export function buildHooksJsonSchema(
	index: DefinitionIndex,
): JSONSchema | null {
	const { source, lazyWrapper } = index;
	// `HC = <lazyWrapper>(()=><alias>.partialRecord(...))` — anchor on the
	// partialRecord call, which is distinctive to the hooks-config validator.
	const anchor = `${index.zodAlias}.partialRecord(`;
	const anchorIdx = source.indexOf(anchor);
	if (anchorIdx === -1) return null;
	// Walk back to the enclosing `=<lazyWrapper>(()=>` and read the symbol.
	const eq = source.lastIndexOf(`=${lazyWrapper}(()=>`, anchorIdx);
	if (eq === -1) return null;
	let nameStart = eq;
	while (nameStart > 0 && /[\w$]/.test(source[nameStart - 1])) nameStart--;
	const hcSym = source.slice(nameStart, eq);
	if (!hcSym) return null;
	const hcDef = index.defs.get(hcSym);
	if (!hcDef) return null;

	const hooksValue = evalZod(hcDef, { index, resolving: new Set() });
	if (hooksValue.type !== "object") return null;
	stripAdditionalPropertiesFalse(hooksValue);

	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "Claude Code hooks.json",
		type: "object",
		properties: { hooks: hooksValue },
		required: ["hooks"],
		description:
			"Claude Code hooks/hooks.json. The `hooks` key maps hook-event names (PreToolUse, PostToolUse, …) to arrays of matcher entries, each holding a list of hook definitions (command / prompt / http / agent / mcp_tool). Same shape as the `hooks` block inside settings.json. Validates the structure of known fields; unknown hook fields are not schema errors — the advisory hooks-json hand-written rules report those.",
	};
}

/**
 * Recursively delete every `additionalProperties:false` in a schema tree. The
 * mcp / hooks schemas must never reject unknown keys (that is the hand-written
 * `no-unknown-*` rules' job) — a stray `.strict()` deep inside a nested object
 * would otherwise turn an unknown field into a false-positive error.
 */
function stripAdditionalPropertiesFalse(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) stripAdditionalPropertiesFalse(child);
		return;
	}
	if (node && typeof node === "object") {
		const obj = node as Record<string, unknown>;
		if (obj.additionalProperties === false) delete obj.additionalProperties;
		for (const value of Object.values(obj)) {
			stripAdditionalPropertiesFalse(value);
		}
	}
}

export function buildPluginSchema(index: DefinitionIndex): JSONSchema {
	const masterName = findMasterSchemaName(index);
	if (!masterName) {
		throw new Error(
			"Could not locate master plugin schema (kebab-case anchor not found)",
		);
	}
	const masterExpr = index.defs.get(masterName);
	if (!masterExpr) {
		throw new Error(`Master schema symbol ${masterName} has no definition`);
	}
	const refs = parseMasterSpread(masterExpr, index.zodAlias, index.lazyWrapper);
	if (refs.length === 0) {
		throw new Error("Master schema spread parsing returned 0 refs");
	}

	const properties: Record<string, JSONSchema> = {};
	const required: string[] = [];
	const ctx: EvalContext = { index, resolving: new Set() };

	for (const ref of refs) {
		const def = index.defs.get(ref.name);
		if (!def) continue;
		const sub = evalZod(def, ctx);
		const subProps = (sub.properties as Record<string, JSONSchema>) ?? {};
		const subRequired = (sub.required as string[]) ?? [];
		for (const [k, v] of Object.entries(subProps)) {
			properties[k] = v;
		}
		if (!ref.partial) {
			for (const r of subRequired) required.push(r);
		}
	}

	const out: JSONSchema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "Claude Code plugin.json",
		type: "object",
		properties,
	};
	if (required.length > 0) out.required = [...new Set(required)];
	return out;
}

// ---------------------------------------------------------------------------
// 8. Main
// ---------------------------------------------------------------------------

function main() {
	const versionIdx = process.argv.indexOf("--version");
	const requestedVersion =
		versionIdx !== -1 ? process.argv[versionIdx + 1] : undefined;
	const label = requestedVersion ? `v${requestedVersion}` : "latest";
	console.log(pc.cyan(`▸ Fetching @anthropic-ai/claude-code (${label})...`));
	const { source, version } = fetchBundle(requestedVersion);
	console.log(
		pc.cyan("▸ Indexing definitions"),
		pc.dim(`(v${version}, ${(source.length / 1e6).toFixed(1)}MB)`),
	);

	const index = indexDefinitions(source);
	console.log(
		pc.dim(`  ${index.defs.size} definitions, Zod alias = ${index.zodAlias}`),
	);

	const masterName = findMasterSchemaName(index);
	console.log(pc.cyan(`▸ Master schema: ${masterName ?? "<not found>"}`));

	const schema = buildPluginSchema(index);
	const propCount = Object.keys(schema.properties as object).length;
	const reqCount = ((schema.required as string[]) ?? []).length;
	console.log(
		pc.cyan(
			`▸ Composed schema: ${propCount} properties, ${reqCount} required`,
		),
	);

	const rootDir = join(import.meta.dirname!, "..");
	const outPath = join(rootDir, "contracts", "plugin.schema.json");

	// Drift gate: compare the new property set to the previous extraction and
	// fail loudly if we lost >30% of the fields. Mirrors extract-contracts.ts.
	// Override with FORCE_SCHEMA=1 if the loss is intentional (e.g., upstream
	// removed an experimental field).
	let prevSchema: { properties?: Record<string, unknown> } | null = null;
	try {
		const prev = JSON.parse(readFileSync(outPath, "utf8")) as {
			schema?: { properties?: Record<string, unknown> };
		};
		prevSchema = prev.schema ?? null;
	} catch {
		// no previous file — first run
	}
	if (prevSchema) {
		const prevKeys = new Set(Object.keys(prevSchema.properties ?? {}));
		const nowKeys = new Set(
			Object.keys(schema.properties as Record<string, unknown>),
		);
		const lost = [...prevKeys].filter((k) => !nowKeys.has(k));
		const gained = [...nowKeys].filter((k) => !prevKeys.has(k));
		if (gained.length > 0) {
			console.log(
				pc.green(`  + Schema gained: ${gained.sort().join(", ")}`),
			);
		}
		if (lost.length > 0) {
			const dropRate = lost.length / prevKeys.size;
			const msg = `Schema lost ${lost.length}/${prevKeys.size} top-level fields (${(dropRate * 100).toFixed(0)}%): ${lost.sort().join(", ")}`;
			if (dropRate > 0.3 && process.env.FORCE_SCHEMA !== "1") {
				console.log(pc.red(`  ✗ ${msg}`));
				console.log(pc.red("    Set FORCE_SCHEMA=1 to override."));
				process.exit(1);
			}
			console.log(pc.yellow(`  ⚠ ${msg}`));
		}
	}
	const wrapped = {
		extractedFromClaudeCodeVersion: version,
		extractedAt: new Date().toISOString(),
		schema,
	};
	writeFileSync(outPath, JSON.stringify(wrapped, null, "\t") + "\n");
	console.log(pc.dim(`  Written to ${outPath}`));

	// LSP schema (record of server-name → RSH)
	const lspSchema = buildLspSchema(index);
	if (lspSchema) {
		const lspPath = join(rootDir, "contracts", "lsp.schema.json");
		writeFileSync(
			lspPath,
			JSON.stringify(
				{
					extractedFromClaudeCodeVersion: version,
					extractedAt: new Date().toISOString(),
					schema: lspSchema,
				},
				null,
				"\t",
			) + "\n",
		);
		console.log(pc.cyan(`▸ LSP schema written to ${lspPath}`));
	} else {
		console.log(
			pc.yellow(
				"  ⚠ Could not locate LSP per-server schema (extensionToLanguage anchor)",
			),
		);
	}

	// Monitors schema (array of M09)
	const monitorsSchema = buildMonitorsSchema(index);
	if (monitorsSchema) {
		const monPath = join(rootDir, "contracts", "monitors.schema.json");
		writeFileSync(
			monPath,
			JSON.stringify(
				{
					extractedFromClaudeCodeVersion: version,
					extractedAt: new Date().toISOString(),
					schema: monitorsSchema,
				},
				null,
				"\t",
			) + "\n",
		);
		console.log(pc.cyan(`▸ Monitors schema written to ${monPath}`));
	} else {
		console.log(
			pc.yellow(
				"  ⚠ Could not locate monitors schema (unique-name anchor)",
			),
		);
	}

	// Settings schema (y.object({...}).passthrough())
	const settingsSchema = buildSettingsSchema(index);
	if (settingsSchema) {
		const settingsPath = join(rootDir, "contracts", "settings.schema.json");
		const settingsPropCount = Object.keys(
			(settingsSchema.properties as object) ?? {},
		).length;
		writeFileSync(
			settingsPath,
			JSON.stringify(
				{
					extractedFromClaudeCodeVersion: version,
					extractedAt: new Date().toISOString(),
					schema: settingsSchema,
				},
				null,
				"\t",
			) + "\n",
		);
		console.log(
			pc.cyan(
				`▸ Settings schema written to ${settingsPath} (${settingsPropCount} top-level fields)`,
			),
		);
	} else {
		console.log(
			pc.yellow(
				"  ⚠ Could not locate settings schema ($schema describe anchor)",
			),
		);
	}

	// Markdown frontmatter schemas (SKILL.md / agent .md / command .md) plus the
	// standalone JSON config schemas (mcp.json / hooks.json).
	const frontmatterTargets: Array<{
		label: string;
		file: string;
		build: (i: DefinitionIndex) => JSONSchema | null;
	}> = [
		{
			label: "Skill frontmatter",
			file: "skill-frontmatter.schema.json",
			build: buildSkillFrontmatterSchema,
		},
		{
			label: "Agent frontmatter",
			file: "agent-frontmatter.schema.json",
			build: buildAgentFrontmatterSchema,
		},
		{
			label: "Command frontmatter",
			file: "command-frontmatter.schema.json",
			build: buildCommandFrontmatterSchema,
		},
		{
			label: "MCP config",
			file: "mcp.schema.json",
			build: buildMcpJsonSchema,
		},
		{
			label: "Hooks config",
			file: "hooks.schema.json",
			build: buildHooksJsonSchema,
		},
	];
	for (const target of frontmatterTargets) {
		const fmSchema = target.build(index);
		if (fmSchema) {
			const fmPath = join(rootDir, "contracts", target.file);
			const fmFieldCount = Object.keys(
				(fmSchema.properties as object) ?? {},
			).length;
			writeFileSync(
				fmPath,
				JSON.stringify(
					{
						extractedFromClaudeCodeVersion: version,
						extractedAt: new Date().toISOString(),
						schema: fmSchema,
					},
					null,
					"\t",
				) + "\n",
			);
			console.log(
				pc.cyan(
					`▸ ${target.label} schema written to ${fmPath} (${fmFieldCount} fields)`,
				),
			);
		} else {
			console.log(
				pc.yellow(`  ⚠ Could not locate ${target.label} schema`),
			);
		}
	}
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	main();
}
