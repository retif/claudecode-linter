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
import { extractBunEmbeddedModules } from "./extract-contracts.js";

// ---------------------------------------------------------------------------
// 1. Bundle acquisition — the module recovery is shared with
//    extract-contracts.ts (`extractBunEmbeddedModules`); what is local here is
//    the normalisation that turns the recovered modules into a single corpus
//    the Zod walker can index.
// ---------------------------------------------------------------------------

/**
 * Half-open `[start, end)` offsets of one normalised module inside the corpus.
 *
 * The corpus is a concatenation, so the boundaries the minifier's module scopes
 * live in are still recoverable — which is the whole basis of module-scoped
 * symbol resolution. See `buildCorpusWithRanges`.
 */
export interface ModuleRange {
	start: number;
	end: number;
}

export interface BundleResult {
	/** The normalised, concatenated corpus the walker indexes. */
	source: string;
	/** The raw recovered modules, before normalisation. */
	modules: string[];
	version: string;
	/**
	 * Offsets of each normalised module within `source`, in order. Empty only
	 * when the corpus was not built from recovered modules.
	 */
	moduleRanges: ModuleRange[];
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
			const legacy = readFileSync(legacyCli, "utf8");
			const legacyCorpus = buildCorpusWithRanges([legacy]);
			return {
				source: legacyCorpus.source,
				modules: [legacy],
				version: pkg.version,
				moduleRanges: legacyCorpus.moduleRanges,
			};
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
		const modules = extractBunEmbeddedModules(binary, pkg.version);
		const corpus = buildCorpusWithRanges(modules);
		return {
			source: corpus.source,
			modules,
			version: pkg.version,
			moduleRanges: corpus.moduleRanges,
		};
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 1b. Normalising a code-split bundle into one indexable corpus
//
// Up to ~2.1.197 the bundle was one CJS module in which Zod was reached through
// a single namespace alias — `y.object({…})`, `y.string()`. The whole walker is
// built on that shape: `indexDefinitions` scans for `<name>=<alias>.object({`,
// and `evalHead` dispatches on `<alias>.<method>`.
//
// 2.1.259 ships a code-split ESM bundle (~1,635 modules) in which each module
// imports the Zod factories it needs as *bare minified bindings* from a shared
// chunk:
//
//   import{…,i,T,c,nt,Ge,ui,ge,ee,I,BS,hs}from"/$bunfs/root/chunk-84vc68b7.js";
//   var ss=m(()=>i().min(1)), _d=m(()=>nt({name:i().min(1)…}));
//
// There is no alias to detect, so `detectZodAlias` found nothing, every
// definition scan came back empty, and the run died — oleks/claudecode-linter#31.
//
// The fix is a normalisation pass rather than a second walker: recover the
// modules (shared with extract-contracts.ts), work out what each imported
// binding means, and rewrite every call site back into the `<alias>.<method>`
// form the walker already understands. `c({…})` becomes `__zod.object({…})`,
// `i()` becomes `__zod.string()`. Namespace-style modules are rewritten to the
// same alias so one corpus has one alias. Everything downstream is unchanged.
// ---------------------------------------------------------------------------

/** The single Zod alias every normalised module is rewritten to. */
export const CANONICAL_ZOD_ALIAS = "__zod";

/** Read a balanced `{…}` body starting at `braceIdx`, capped for safety. */
function readBraceBody(src: string, braceIdx: number, cap = 2000): string {
	let depth = 0;
	const end = Math.min(src.length, braceIdx + cap);
	for (let i = braceIdx; i < end; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return src.slice(braceIdx, i + 1);
		}
	}
	return src.slice(braceIdx, end);
}

function escapeIdent(name: string): string {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map a Zod chunk's minified factory functions to the Zod method they build.
 *
 * Two independent signals, so a rename on either side alone cannot blind this:
 *
 *  1. **The def literal.** Every factory constructs its schema from an object
 *     carrying the type tag Zod itself uses — `function c(e,r){let t={type:
 *     "object",shape:e??{}…`, `function ee(e,r){…{type:"enum",entries:t…`. The
 *     tag is the method name, so it is read straight out of the body.
 *  2. **The class symbol.** Factories that delegate (`function i(e){return
 *     Sn(Wtt,e)}`) carry no tag, but the symbol they pass was declared as
 *     `Wtt=pn("ZodString",…)` — the class-name string is unminified, so
 *     `ZodString` → `string`.
 *
 * `object` is refined to `strictObject` when the factory pins a `catchall`, and
 * `union` to `discriminatedUnion` when it takes a discriminator, because the
 * walker treats those as distinct methods.
 */
export function mapZodFactories(source: string): Map<string, string> {
	const classSymbols = new Map<string, string>();
	for (const m of source.matchAll(
		/([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\("(Zod[A-Za-z0-9]+)"/g,
	)) {
		classSymbols.set(m[1], m[2]);
	}

	const factories = new Map<string, string>();
	for (const m of source.matchAll(/function ([A-Za-z_$][\w$]*)\([^)]*\)\{/g)) {
		const body = readBraceBody(source, m.index + m[0].length - 1);
		let method: string | null = null;

		const tag = body.match(/type:"([a-z_]+)"/);
		if (tag) method = tag[1];
		if (method === "object" && /catchall:/.test(body)) method = "strictObject";
		if (method === "union" && /discriminator/.test(body))
			method = "discriminatedUnion";
		// `record` and `partialRecord` build the same `type:"record"` def and
		// differ only in that the partial form clears the key type's
		// exhaustiveness values. The walker treats both alike, but the hooks
		// schema is *located* by its `partialRecord` call, so the distinction
		// has to survive normalisation.
		if (method === "record" && /_zod\.values\s*=\s*void 0/.test(body))
			method = "partialRecord";

		if (!method) {
			for (const [symbol, className] of classSymbols) {
				const re = new RegExp(`(?<![.\\w$])${escapeIdent(symbol)}(?![\\w$])`);
				if (!re.test(body)) continue;
				const bare = className.replace(/^Zod/, "");
				method = bare[0].toLowerCase() + bare.slice(1);
				break;
			}
		}
		if (method) factories.set(m[1], method);
	}
	return factories;
}

/** How many `X=Y("ZodFoo"` declarations mark a module as a Zod runtime chunk. */
const ZOD_CHUNK_CLASS_FLOOR = 10;

/** Harvest the factory map from every module that looks like a Zod chunk. */
export function collectZodFactories(modules: string[]): Map<string, string> {
	const factories = new Map<string, string>();
	for (const mod of modules) {
		const declarations = mod.match(/\("Zod[A-Za-z0-9]+"/g);
		if (!declarations || declarations.length < ZOD_CHUNK_CLASS_FLOOR) continue;
		for (const [name, method] of mapZodFactories(mod)) {
			if (!factories.has(name)) factories.set(name, method);
		}
	}
	return factories;
}

/** The local names an ESM module binds through `import{…}from"…"`. */
function importedBindings(source: string): Set<string> {
	const names = new Set<string>();
	for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*"/g)) {
		for (const part of m[1].split(",")) {
			const local = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (local && /^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
		}
	}
	return names;
}

/**
 * How many Zod call sites a module must contain before it is normalised.
 *
 * A module that merely re-exports one helper is noise in the corpus; requiring
 * a handful of rewrites keeps the corpus to the modules that actually declare
 * schemas, which both shrinks it and lowers the chance of two modules
 * contributing the same minified symbol.
 */
const MIN_ZOD_CALL_SITES = 3;

/**
 * Rewrite one module's Zod call sites to `CANONICAL_ZOD_ALIAS.<method>(…)`.
 *
 * Returns `null` when the module carries no meaningful Zod usage, so the caller
 * can drop it from the corpus.
 */
export function normalizeZodModule(
	source: string,
	factories: Map<string, string>,
): string | null {
	let out = source;
	let rewrites = 0;

	// (a) Namespace style (<= 2.1.197, and modules that still bundle their own
	//     Zod namespace): `y.object({` → `__zod.object({`. The alias is a single
	//     module-scoped binding, so rewriting every `y.` on it is safe.
	const namespaceCounts = new Map<string, number>();
	for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\.object\(\{/g)) {
		namespaceCounts.set(m[1], (namespaceCounts.get(m[1]) ?? 0) + 1);
	}
	let namespaceAlias: string | null = null;
	let namespaceHits = 0;
	for (const [alias, n] of namespaceCounts) {
		if (n > namespaceHits) {
			namespaceHits = n;
			namespaceAlias = alias;
		}
	}
	if (namespaceAlias && namespaceHits >= MIN_ZOD_CALL_SITES) {
		out = out.replace(
			new RegExp(`(?<![.\\w$])${escapeIdent(namespaceAlias)}\\.`, "g"),
			`${CANONICAL_ZOD_ALIAS}.`,
		);
		rewrites += namespaceHits;
	}

	// (b) Bare-binding style (2.1.259+): only identifiers this module actually
	//     imports are rewritten, so a same-named local in another module cannot
	//     be dragged in.
	for (const name of importedBindings(source)) {
		const method = factories.get(name);
		if (!method) continue;
		const re = new RegExp(`(?<![.\\w$])${escapeIdent(name)}\\(`, "g");
		const hits = out.match(re);
		if (!hits) continue;
		out = out.replace(re, `${CANONICAL_ZOD_ALIAS}.${method}(`);
		rewrites += hits.length;
	}

	return rewrites >= MIN_ZOD_CALL_SITES ? out : null;
}

/**
 * Turn recovered modules into the single corpus the walker indexes.
 *
 * The corpus is a concatenation rather than a per-module index because the
 * anchors and the definitions they name routinely live in *different* modules:
 * on 2.1.259 the `"plugin-json"` validator dispatch that names the master
 * schema `rhe` sits in module #275, while `rhe`'s definition sits in #51.
 * Indexing each module alone finds the name or the definition, never both.
 */
export function buildCorpus(modules: string[]): string {
	return buildCorpusWithRanges(modules).source;
}

/**
 * `buildCorpus`, plus the offsets each module occupies in the result.
 *
 * The concatenation is what makes anchors resolvable at all, but it also
 * flattens ~1,635 module scopes into one namespace, and minified symbols are
 * module-scoped: on 2.1.259, 161 of the 1,176 factory-bound names are bound in
 * more than one module (`n` in fourteen of them) and 5,312 of the 15,225
 * `function <name>(` declarations are declared in more than one. Keeping the
 * boundaries lets `indexDefinitions` record which module each binding came
 * from, so a reference can resolve to *its own* module's binding rather than to
 * whichever module happened to be concatenated first. Without them the corpus
 * is the only scope there is.
 *
 * The separator is the same single `\n` the join emits, so the ranges tile the
 * corpus exactly and no offset in a module's own text falls outside its range.
 */
export function buildCorpusWithRanges(modules: string[]): {
	source: string;
	moduleRanges: ModuleRange[];
} {
	const factories = collectZodFactories(modules);
	const normalized: string[] = [];
	for (const mod of modules) {
		const n = normalizeZodModule(mod, factories);
		if (n) normalized.push(n);
	}
	// Nothing normalised: either an unrecognised layout or a non-Zod corpus.
	// Fall back to the raw modules so `assertDefinitionsUsable` reports on real
	// content rather than on an empty string.
	const parts = normalized.length === 0 ? modules : normalized;
	const moduleRanges: ModuleRange[] = [];
	let offset = 0;
	for (let i = 0; i < parts.length; i++) {
		if (i > 0) offset += 1; // the "\n" the join inserts
		moduleRanges.push({ start: offset, end: offset + parts[i].length });
		offset += parts[i].length;
	}
	return { source: parts.join("\n"), moduleRanges };
}

/**
 * Which module an offset falls in, or -1 when there are no ranges (a corpus
 * built from a bare string, as every unit test does) or the offset lands on a
 * separator. -1 reads as "no module known", which every resolution path treats
 * as "fall back to corpus-wide behaviour" — never as module 0.
 */
export function moduleOfOffset(ranges: ModuleRange[], pos: number): number {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (pos < ranges[mid].start) hi = mid - 1;
		else if (pos >= ranges[mid].end) lo = mid + 1;
		else return mid;
	}
	return -1;
}

/**
 * Load a Claude Code bundle from a local on-disk install instead of npm.
 *
 * Claude Code's native installer keeps each version's `claude` binary under
 * `~/.local/share/claude/versions/<version>`. When the npm extractor path is
 * unavailable (recent releases ship platform binaries only, and `npm pack` of
 * the platform package can fail in CI), this reads the local binary directly.
 *
 * `pathOrVersion` is either a full path to the binary or a bare version string
 * resolved against the default versions directory.
 */
export function loadLocalBundle(pathOrVersion: string): BundleResult {
	const versionsDir = join(
		process.env.HOME ?? "",
		".local",
		"share",
		"claude",
		"versions",
	);
	const binPath = existsSync(pathOrVersion)
		? pathOrVersion
		: join(versionsDir, pathOrVersion);
	const binary = readFileSync(binPath);
	// Derive the version from the trailing path segment (the versions-dir
	// layout names each binary after its version).
	const version = binPath.split(/[\\/]/).pop() ?? pathOrVersion;
	const modules = extractBunEmbeddedModules(binary, version);
	const corpus = buildCorpusWithRanges(modules);
	return {
		source: corpus.source,
		modules,
		version,
		moduleRanges: corpus.moduleRanges,
	};
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

/**
 * Split a union's branch-array body, flattening spreads of array literals.
 *
 * `z.union([A,B])` and `z.discriminatedUnion("type",[A,B])` normally hold their
 * branches directly, but 2.1.259 writes the per-hook union as
 * `discriminatedUnion("type",[...[e,n,o,s,r]])`. Splitting that at the top
 * level yields the single element `...[e,n,o,s,r]`, which evaluates to a
 * permissive `{}` — one hollow branch in place of command/prompt/agent/http/
 * mcp_tool. Only a spread of a literal array is expanded; a spread of anything
 * else (an identifier the walker cannot see through) is left alone rather than
 * guessed at.
 */
export function splitUnionBranches(arrayBody: string): string[] {
	const out: string[] = [];
	for (const part of splitTopLevelArgs(arrayBody)) {
		const inner = part.startsWith("...") ? part.slice(3).trim() : "";
		if (inner.startsWith("[") && inner.endsWith("]")) {
			out.push(...splitUnionBranches(inner.slice(1, -1)));
		} else {
			out.push(part);
		}
	}
	return out;
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

/**
 * One binding of a symbol, tagged with the module it was declared in.
 *
 * `module` is -1 when the corpus carries no module ranges (a bare-string index,
 * as in the unit tests) — "unknown module", never module 0.
 */
export interface DefSite {
	module: number;
	value: string;
}

export interface DefinitionIndex {
	/** Bundle source. */
	source: string;
	/** Maps symbol name → expression text (right-hand side of the assignment). */
	defs: Map<string, string>;
	/**
	 * Offsets of each normalised module inside `source`; empty when unknown.
	 * See `buildCorpusWithRanges`.
	 */
	moduleRanges: ModuleRange[];
	/**
	 * EVERY factory binding of each name, in source order, each tagged with its
	 * module — the module-scoped view of `defs`.
	 *
	 * `defs` keeps only the first binding, which is why a reference used to
	 * resolve into whichever module the concatenation happened to put first.
	 * `resolveDefSite` reads this instead and prefers the referring
	 * definition's own module. `defs` is retained because it is what
	 * `assertDefinitionsUsable` counts and what the corpus-wide fallback reads.
	 */
	defSites: Map<string, DefSite[]>;
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
	/** Every `<name>=[…]` array binding, tagged with its module. */
	arraySites: Map<string, DefSite[]>;
	/**
	 * Maps symbol name → string value for plain `<name>="..."` declarations.
	 * Claude Code keeps canonical URLs and other tokens in top-level string
	 * variables and feeds them to Zod via `y.literal(<name>)`. Indexing them
	 * here lets `case "literal"` resolve identifiers to the real string
	 * instead of emitting a const literal of the minified identifier name
	 * (the pXq/V0q-style bug fixed by issue #1).
	 */
	stringLits: Map<string, string>;
	/** Every `<name>="…"` string binding, tagged with its module. */
	stringSites: Map<string, DefSite[]>;
}

/**
 * Resolve a symbol to the binding a reference in `fromModule` should see.
 *
 * Order, and why each step is the one it is:
 *
 *  1. **The referring module's own binding.** Minified names are module-scoped,
 *     so if the module holding the reference also binds the name, that binding
 *     is the referent, full stop. This is the step the corpus flattening used
 *     to lose.
 *  2. **A corpus-wide unique binding.** Anchors and the definitions they name
 *     routinely live in different modules (on 2.1.259 the `"plugin-json"`
 *     dispatch naming `rhe` is in one module and `rhe` is defined in another),
 *     so a cross-module reference is normal and must still resolve. When a name
 *     has exactly one binding there is nothing to be ambiguous about.
 *  3. **The first binding.** Ambiguous *and* not bound in the referring module:
 *     nothing in the corpus says which is meant. This is the pre-existing
 *     behaviour, kept deliberately rather than guessed at — it is the case the
 *     module boundaries cannot decide, and changing it would be a coin flip
 *     dressed as a fix.
 */
export function resolveDefSite(
	index: DefinitionIndex,
	name: string,
	fromModule?: number,
): DefSite | null {
	const sites = index.defSites.get(name);
	if (!sites || sites.length === 0) return null;
	if (fromModule !== undefined && fromModule >= 0) {
		const own = sites.find((s) => s.module === fromModule);
		if (own) return own;
	}
	return sites[0];
}

/** Module-scoped lookup in one of the leaf-value indexes (arrays / strings). */
function resolveSite(
	sites: Map<string, DefSite[]> | undefined,
	name: string,
	fromModule?: number,
): string | undefined {
	const found = sites?.get(name);
	if (!found || found.length === 0) return undefined;
	if (fromModule !== undefined && fromModule >= 0) {
		const own = found.find((s) => s.module === fromModule);
		if (own) return own.value;
	}
	return found[0].value;
}

/** Record one binding of `name` in the module containing `offset`. */
function addSite(
	sites: Map<string, DefSite[]>,
	ranges: ModuleRange[],
	name: string,
	offset: number,
	value: string,
): void {
	const module = moduleOfOffset(ranges, offset);
	const list = sites.get(name);
	if (list) {
		// One module may bind a name once as far as resolution is concerned;
		// keeping only the first binding per module mirrors `defs`' own
		// first-wins rule *within* a scope, where it is correct.
		if (!list.some((s) => s.module === module)) {
			list.push({ module, value });
		}
		return;
	}
	sites.set(name, [{ module, value }]);
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
export function indexDefinitions(
	source: string,
	moduleRanges: ModuleRange[] = [],
): DefinitionIndex {
	const defs = new Map<string, string>();
	// Every binding, tagged with its module. Built in the *same* order `defs`
	// is, so `defSites.get(n)[0]` is always the binding `defs.get(n)` holds and
	// the corpus-wide fallback is bit-for-bit the old behaviour.
	const defSites = new Map<string, DefSite[]>();
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
			// One binding per module is recorded; `defs` still keeps only the
			// very first, corpus-wide. `addSite` short-circuits a repeat within
			// the same module, so this only re-extracts for a genuinely new one.
			const knownModules = defSites.get(name);
			if (
				knownModules?.some(
					(s) => s.module === moduleOfOffset(moduleRanges, idx),
				)
			)
				continue;
			// extract the RHS expression text
			const expr = extractExpression(source, idx);
			if (!expr) continue;
			if (!defs.has(name)) defs.set(name, expr);
			addSite(defSites, moduleRanges, name, idx, expr);
		}
	}

	// Index plain `<name>=[...]` array-literal declarations whose elements are
	// all string literals. These back `y.enum(<name>)` references (e.g. the
	// hook-event list `ev`, the shell list `DLq`). Only string-of-strings
	// arrays are indexed — that is all `y.enum(...)` ever consumes.
	const arrays = new Map<string, string>();
	const arraySites = new Map<string, DefSite[]>();
	const arrRe = /(?:^|[;,{(\s])([A-Za-z_$][\w$]*)=\[/g;
	let am: RegExpExecArray | null;
	while ((am = arrRe.exec(source)) !== null) {
		const name = am[1];
		const at = am.index;
		const arrModule = moduleOfOffset(moduleRanges, at);
		if (arraySites.get(name)?.some((s) => s.module === arrModule)) continue;
		const bracketIdx = source.indexOf("[", at);
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
		if (!allStrings) continue;
		if (!arrays.has(name)) arrays.set(name, arr);
		addSite(arraySites, moduleRanges, name, at, arr);
	}

	// Index bare alias assignments — `<name>=<ident>` where `<ident>` is itself
	// an already-indexed schema-factory symbol. Claude Code's frontmatter is
	// typed through such aliases: `z36=()=>y.union([…]),LW,lFH,…` followed by
	// `LW=z36,lFH=z36` — `name:LW().optional()`, `model:LW()`, etc. all bottom
	// out in `z36`. Without this pass `LW()`/`lFH()` resolve to nothing and the
	// field degrades to a `{}` placeholder.
	//
	// We record the alias as `<target>()` so the chain evaluator follows
	// `LW -> z36() -> ()=>y.union([…])`. Alias chains (`A=B,B=z36`) are resolved
	// to a fixpoint. Only aliases whose ultimate target is an indexed factory
	// are recorded — a stricter check than a raw `<name>=<ident>` scan, so an
	// unrelated `X=Y` assignment is never mistaken for a schema and the worst
	// case stays the permissive `{}` fallback.
	//
	// Scanned identifier value must be a single bare identifier (no method
	// chain, no call) so we only catch genuine `LW=z36`-style aliases.
	const aliasRe =
		/(?:^|[;,{(\s])([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)(?=[;,)}\s]|$)/g;
	//
	// EVERY binding of a name is kept, not just the first. The corpus is a
	// concatenation of ~1,635 code-split modules whose minified symbols are
	// module-scoped, so one short name is routinely bound in many modules —
	// `u_` in seven of them on 2.1.259. First-binding-wins let an unrelated
	// module's dead-end `u_=<non-factory>` shadow the skill module's
	// `u_=aJe`, and `name`/`description` on skill, agent and command
	// frontmatter degraded to permissive `{}` placeholders as a result.
	// Trying each candidate and keeping the one that actually bottoms out in
	// an indexed factory is both order-independent and conservative: a name
	// with no factory-backed binding still resolves to nothing.
	//
	// Each candidate carries the module its `<name>=<target>` declaration sits
	// in, so an alias resolves through its own module's binding of the target
	// when there is one — the same module-scoping the factory index gets.
	const aliasPairs = new Map<string, Array<{ target: string; module: number }>>();
	let alm: RegExpExecArray | null;
	while ((alm = aliasRe.exec(source)) !== null) {
		const name = alm[1];
		const target = alm[2];
		const aliasModule = moduleOfOffset(moduleRanges, alm.index);
		if (name === target) continue;
		// Only an existing *definition* blocks an alias. An array binding must
		// not: `defs` answers `<name>()` calls and `arrays` answers
		// `<alias>.enum(<name>)`, so the two are read in different positions and
		// a name may legitimately be both — across 1,635 modules it often is.
		// On 2.1.259 an unrelated module's `u_=["stylesheet","stale-banner",
		// "stamp-control"]` vetoed the skill module's `u_=aJe`, which is why
		// `name`/`description` came out untyped on all three frontmatter
		// schemas while the sibling alias `O1=aJe` resolved fine.
		if (defs.has(name)) continue;
		const targets = aliasPairs.get(name);
		if (targets) {
			if (
				!targets.some((t) => t.target === target && t.module === aliasModule)
			) {
				targets.push({ target, module: aliasModule });
			}
		} else {
			aliasPairs.set(name, [{ target, module: aliasModule }]);
		}
	}
	// Resolve each alias to a factory-backed target, following alias chains.
	//
	// A name aliased in several modules gets one recorded site per module, so
	// `LW=z36` in the skill module and an unrelated `LW=<other>` elsewhere no
	// longer compete: each resolves for references in its own module. `defs`
	// still takes the first resolution corpus-wide, keeping the fallback path
	// exactly as it was.
	for (const [name, candidates] of aliasPairs) {
		const resolvedModules = new Set<number>();
		for (const candidate of candidates) {
			if (resolvedModules.has(candidate.module)) continue;
			const seen = new Set<string>([name]);
			let target: string | undefined = candidate.target;
			while (target !== undefined && !seen.has(target)) {
				// Prefer the alias's own module's binding of the target, falling
				// back to the corpus-wide first — the same rule `resolveDefSite`
				// applies, inlined because the index is still being built.
				const targetSites = defSites.get(target);
				if (targetSites && targetSites.length > 0) {
					// `LW()` is `target()` — calling the aliased factory. Which
					// binding of `target` that call means is decided later, by
					// `resolveDefSite` against the alias site's own module.
					if (!defs.has(name)) defs.set(name, `${target}()`);
					const list = defSites.get(name);
					if (list) {
						if (!list.some((s) => s.module === candidate.module)) {
							list.push({ module: candidate.module, value: `${target}()` });
						}
					} else {
						defSites.set(name, [
							{ module: candidate.module, value: `${target}()` },
						]);
					}
					resolvedModules.add(candidate.module);
					break;
				}
				seen.add(target);
				// Follow the chain through whichever binding of the next hop
				// resolves; the same shadowing applies one link down. Same-module
				// hops are preferred over cross-module ones.
				const hops = aliasPairs.get(target)?.filter((t) => !seen.has(t.target));
				target =
					(candidate.module >= 0
						? hops?.find((t) => t.module === candidate.module)?.target
						: undefined) ?? hops?.[0]?.target;
			}
		}
	}

	// Index plain `<name>="..."` string-literal assignments. These back
	// `y.literal(<name>)` references in the settings schema, e.g.
	// `V0q="https://json.schemastore.org/claude-code-settings.json"` then
	// `$schema:y.literal(V0q).optional()`. Without this pass, `case "literal"`
	// captured the bare minified identifier (`V0q`/`pXq`) as the const value.
	const stringLits = new Map<string, string>();
	const stringSites = new Map<string, DefSite[]>();
	const strRe = /(?:^|[;,{(\s])([A-Za-z_$][\w$]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)(?=[;,)}\s]|$)/g;
	let sm: RegExpExecArray | null;
	while ((sm = strRe.exec(source)) !== null) {
		const name = sm[1];
		const at = sm.index;
		const strModule = moduleOfOffset(moduleRanges, at);
		if (stringSites.get(name)?.some((site) => site.module === strModule))
			continue;
		const raw = sm[2];
		let value: string;
		try {
			value = JSON.parse(
				raw.replace(/^'|'$/g, '"').replace(/^`|`$/g, '"'),
			) as string;
		} catch {
			value = raw.slice(1, -1);
		}
		if (!stringLits.has(name)) stringLits.set(name, value);
		addSite(stringSites, moduleRanges, name, at, value);
	}

	return {
		source,
		defs,
		zodAlias,
		lazyWrapper,
		arrays,
		stringLits,
		moduleRanges,
		defSites,
		arraySites,
		stringSites,
	};
}

/**
 * How many Zod definitions a usable index must hold.
 *
 * A healthy 2.1.259 corpus indexes ~1,400. The floor is deliberately far below
 * that: an upstream refactor that halves the schema count is a warning for the
 * per-schema drift gates to raise, not a failure here. What this catches is the
 * shape that actually happens — a layout or minifier change that leaves the
 * index at or near zero.
 */
const MIN_DEFINITIONS = 50;

/**
 * Refuse an index that found (almost) nothing.
 *
 * This is the half of oleks/claudecode-linter#31 that matters. The walker is
 * built to degrade rather than fail — every pattern it does not recognise
 * becomes a permissive `{}` — which is right for one unknown field and
 * catastrophic for a whole bundle: with an empty index every schema either
 * comes out as an empty permissive object or is skipped with a yellow warning,
 * and the run still exits 0. Downstream that reads as "Claude Code validates
 * nothing", silently disabling every linter rule backed by these schemas.
 *
 * So an empty index is fatal here, before a single schema is written. An error
 * must never collapse into an apparently-successful extraction.
 */
export function assertDefinitionsUsable(index: DefinitionIndex): void {
	if (index.defs.size >= MIN_DEFINITIONS) return;
	throw new Error(
		`Indexed ${index.defs.size} Zod definitions (alias "${index.zodAlias}", ` +
			`lazy wrapper "${index.lazyWrapper}") from a ${(index.source.length / 1e6).toFixed(1)}MB ` +
			`corpus — below the floor of ${MIN_DEFINITIONS}. Refusing to write ` +
			`schemas: an empty index yields permissive, rule-disabling schemas that ` +
			`look like a successful extraction. The bundle layout or the Zod call ` +
			`form has probably changed again — re-check normalizeZodModule() and ` +
			`mapZodFactories() against the new bundle.`,
	);
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
	// Find the most common alias used for .object({...}). Multi-character
	// aliases are allowed so a normalised corpus (`__zod.object({`) is detected
	// as readily as a legacy single-letter minified one (`y.object({`); the
	// winner is whichever alias carries the most call sites, which on a
	// normalised corpus is the canonical one by a wide margin.
	const candidates = new Map<string, number>();
	const re = /\b([A-Za-z_$][\w$]*)\.object\(\{/g;
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
 * Find the plugin.json master schema symbol.
 *
 * Two extraction strategies are tried in order, so the walker spans the
 * releases that moved the anchor around:
 *
 *  1. **kebab-case adjacency** (≤ 2.1.196) — the master schema was validated
 *     inline via `<master>().strict().safeParse(...)` (or the bare
 *     `.safeParse(` form after 2.1.150) sitting right next to the
 *     "is not kebab-case" name-validation error string.
 *
 *  2. **type-string dispatch** (2.1.197+) — Claude Code replaced the inline
 *     validation with a hand-rolled imperative manifest linter, so the
 *     "is not kebab-case" string no longer sits beside any `.safeParse(`.
 *     The Zod schema is now validated inside a generic validator dispatched by
 *     artifact-type string: `KWe(candidate,"plugin-json",{…})`, whose body
 *     calls `<master>().safeParse(…)`. We locate the validator via the
 *     "plugin-json" type-string call site, then read the master symbol from
 *     its `<sym>().safeParse(` call.
 */
export function findMasterSchemaName(index: DefinitionIndex): string | null {
	return findMasterSchemaSite(index)?.name ?? null;
}

/**
 * `findMasterSchemaName`, plus the module the naming *call site* sits in.
 *
 * That is the module doing the referring, not necessarily the one holding the
 * definition — on 2.1.259 the `"plugin-json"` dispatch that names `rhe` and
 * `rhe`'s own declaration are in different modules, which is exactly why a
 * cross-module fallback has to exist alongside the own-module preference.
 */
export function findMasterSchemaSite(
	index: DefinitionIndex,
): { name: string; module: number } | null {
	return (
		findMasterViaKebabAnchor(index.source, index.moduleRanges) ??
		findMasterViaTypeDispatch(index.source, index.moduleRanges)
	);
}

/** Strategy 1: `<master>().safeParse(` adjacent to the kebab-case error. */
function findMasterViaKebabAnchor(
	source: string,
	moduleRanges: ModuleRange[],
): { name: string; module: number } | null {
	const anchor = "is not kebab-case";
	const anchorIdx = source.indexOf(anchor);
	if (anchorIdx === -1) return null;
	// Search backwards for the nearest `.strict().safeParse(` or, on bundles
	// where `.strict()` is no longer chained inline (Claude Code 2.1.150+
	// dropped it from the call site — the masterSchema's `.strict()` still
	// lives inside its own definition), the bare `.safeParse(` form.
	const windowStart = Math.max(0, anchorIdx - 4000);
	const search = source.slice(windowStart, anchorIdx);
	let callIdx = search.lastIndexOf(".strict().safeParse(");
	if (callIdx === -1) callIdx = search.lastIndexOf(".safeParse(");
	if (callIdx === -1) return null;
	const absoluteCallIdx = windowStart + callIdx;
	// Walk back across `().` to find the symbol name.
	const i = absoluteCallIdx - 1;
	// expect pattern: <name>()
	if (source.slice(i - 1, i + 1) !== "()") return null;
	const nameEnd = i - 1;
	let nameStart = nameEnd;
	while (nameStart > 0 && /[\w$]/.test(source[nameStart - 1])) nameStart--;
	if (nameStart === nameEnd) return null;
	return {
		name: source.slice(nameStart, nameEnd),
		module: moduleOfOffset(moduleRanges, nameStart),
	};
}

/**
 * Strategy 2: locate the `"plugin-json"` artifact-type validator dispatch, then
 * read the master schema symbol from the `<sym>().safeParse(` inside the
 * validator's body.
 */
function findMasterViaTypeDispatch(
	source: string,
	moduleRanges: ModuleRange[],
): { name: string; module: number } | null {
	const validator = findValidatorCallName(source, "plugin-json");
	if (!validator) return null;
	// The validator may be declared as a statement (`function <V>(…)`) or bound
	// to a variable as an arrow / function expression
	// (`<V>=(…)=>{…}`, `<V>=async(…)=>{…}`, `<V>=function(…){…}`).
	const esc = validator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const defRe = new RegExp(
		`(?:function\\s+${esc}\\s*\\(|\\b${esc}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\()`,
	);
	const def = defRe.exec(source);
	if (!def) return null;
	const defIdx = def.index;
	const body = source.slice(defIdx, defIdx + 4000);
	const sp = body.match(/([\w$]+)\(\)\.safeParse\(/);
	if (!sp) return null;
	return {
		name: sp[1],
		module: moduleOfOffset(moduleRanges, defIdx + (sp.index ?? 0)),
	};
}

/**
 * Find the identifier of the function called with `typeString` as one of its
 * arguments, e.g. `KWe(candidate,"plugin-json",{…})` → `KWe`. Scans backward
 * from the type-string literal across balanced brackets to the call's opening
 * paren, then reads the identifier before it.
 */
function findValidatorCallName(
	source: string,
	typeString: string,
): string | null {
	// The minifier usually emits double-quoted strings, but tolerate single
	// quotes too so a quote-style rotation can't silently break extraction.
	for (const needle of [`"${typeString}"`, `'${typeString}'`]) {
		let from = 0;
		let idx: number;
		while ((idx = source.indexOf(needle, from)) !== -1) {
			from = idx + 1;
			// Walk back across balanced brackets to the enclosing call's `(`.
			let depth = 0;
			let i = idx - 1;
			for (; i >= 0; i--) {
				const c = source[i];
				if (c === ")" || c === "]" || c === "}") depth++;
				else if (c === "[" || c === "{") {
					if (depth === 0) break; // hit an object/array literal — not a call
					depth--;
				} else if (c === "(") {
					if (depth === 0) break; // enclosing call paren
					depth--;
				}
			}
			if (i < 0 || source[i] !== "(") continue;
			const nameEnd = i;
			let nameStart = nameEnd;
			while (nameStart > 0 && /[\w$]/.test(source[nameStart - 1])) nameStart--;
			if (nameStart < nameEnd) return source.slice(nameStart, nameEnd);
		}
	}
	return null;
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
	/**
	 * Which module the expression being evaluated was declared in, or undefined
	 * / -1 when unknown. Every symbol looked up while evaluating it resolves
	 * against this module first — that is what makes a reference mean its own
	 * module's binding. It is threaded, not global: following a reference into
	 * another module's definition switches it to that module for the subtree.
	 */
	module?: number;
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
		const parts = splitTopLevelArgs(pairs);
		// The destructured keys identify which of the same-named functions is
		// the one meant here — see `evalFunctionReturnObject`.
		const wantedKeys = parts.map((part) => {
			const entry = parseEntry(part);
			return entry ? entry.key : part.trim();
		});
		const returned = evalFunctionReturnObject(fnName, ctx, wantedKeys);
		if (!returned) continue;
		for (const part of parts) {
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
	wantedKeys: string[] = [],
): Map<string, string> | null {
	const { source, moduleRanges } = ctx.index;
	// EVERY `function <name>(` is tried, and the one that supplies the keys the
	// caller asked for wins. The corpus concatenates ~1,635 code-split modules
	// whose function names are module-scoped, so a short minified name is
	// declared many times over: 2.1.259 has eleven `function Fl(`, and the
	// first is an unrelated string helper while the hook-schema bundle is the
	// second. Taking the first match dropped the whole per-hook discriminated
	// union — command/prompt/http/agent/mcp_tool — leaving `hooks.items` as a
	// permissive `{}` that accepts a malformed hook silently.
	//
	// The key filter alone is not enough on its own terms: two modules can both
	// declare a `function <name>(` returning the same key names, and then the
	// first one wins for no better reason than concatenation order. So the
	// caller's OWN module is swept first — a call site's `<fn>()` means that
	// module's `<fn>` when it has one — and only then the rest of the corpus.
	// 5,312 of 15,225 function names on 2.1.259 are declared in more than one
	// module, `Z` and `G` in fifty-seven each.
	const needle = `function ${fnName}(`;
	const offsets: number[] = [];
	for (
		let fnIdx = source.indexOf(needle);
		fnIdx !== -1;
		fnIdx = source.indexOf(needle, fnIdx + 1)
	) {
		offsets.push(fnIdx);
	}
	const own =
		ctx.module !== undefined && ctx.module >= 0
			? offsets.filter(
					(o) => moduleOfOffset(moduleRanges, o) === ctx.module,
				)
			: [];
	for (const fnIdx of own.concat(offsets.filter((o) => !own.includes(o)))) {
		const candidate = parseFunctionReturnObject(source, fnIdx);
		if (!candidate) continue;
		if (wantedKeys.every((k) => candidate.has(k))) return candidate;
	}
	return null;
}

/**
 * Parse one `function …(){…}` occurrence at `fnIdx` into a `key → schemaExpr`
 * map, or null when it does not return an object literal.
 */
function parseFunctionReturnObject(
	source: string,
	fnIdx: number,
): Map<string, string> | null {
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
	const { zodAlias } = ctx.index;
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
		// A local binding is already in scope, so it keeps the current module;
		// a top-level one moves evaluation into the module it was declared in.
		const site = localBound
			? undefined
			: resolveDefSite(ctx.index, name, ctx.module);
		const def = localBound ?? site?.value;
		if (def === undefined) return {};
		const next: EvalContext =
			site && site.module !== ctx.module ? { ...ctx, module: site.module } : ctx;
		ctx.resolving.add(name);
		try {
			return evalZod(def, next);
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
			const raw = args[0].trim();
			// `y.literal(<ident>)` — resolve the identifier through the
			// string-literal index built in `indexDefinitions`. Without this,
			// a bare identifier round-tripped through `evalLiteralValue` would
			// surface as `{ const: "<minified-name>" }` and reject every valid
			// value (the pXq/V0q bug — gitea issue #1).
			const identMatch = raw.match(/^[A-Za-z_$][\w$]*$/);
			if (identMatch) {
				const resolved = resolveSite(
					ctx.index.stringSites,
					raw,
					ctx.module,
				);
				if (resolved !== undefined) return { const: resolved };
				// Unresolved identifier — assume string-typed but don't pin a
				// const value. Safer than emitting a bogus const.
				return { type: "string" };
			}
			return { const: evalLiteralValue(raw) };
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
					const resolved = resolveSite(
						ctx.index.arraySites,
						idMatch[1],
						ctx.module,
					);
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
				const branches = splitUnionBranches(arr.slice(1, -1)).map((e) =>
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
				const branches = splitUnionBranches(arr.slice(1, -1)).map((e) =>
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
			const site = resolveDefSite(ctx.index, idCall[1], ctx.module);
			if (site)
				return isOptional(
					site.value,
					site.module === ctx.module ? ctx : { ...ctx, module: site.module },
					depth + 1,
				);
		}
	}

	// Look inside a wrapper call's arguments.
	//
	// Optionality is not always on the outer chain. Claude Code wraps fields in
	// schema-to-schema combinators that carry the real schema as an argument:
	//
	//   metadata:  <alias>.pipe((e)=>…, <alias>.record(…).optional())
	//   policyHelper:  s(Mt().optional(), (r)=>…)     // minified preprocess
	//
	// Both are optional, and reading only the outer chain calls them required —
	// which is how a valid settings.json and a valid plugin.json came to be
	// rejected. A combinator is transparent to optionality, so an optional
	// argument makes the field optional.
	//
	// The head must actually BE a call (`<ident>(` or `<a>.<b>(`) for this to
	// apply. That guard is what keeps an object literal from leaking its
	// fields' optionality upward: in `<alias>.object({name:X.optional()})` the
	// argument is `{name:X.optional()}`, whose own head is a brace and not a
	// call, so the recursion stops there rather than declaring the object
	// itself optional.
	if (ctx && depth < 8) {
		const head = chain[0]?.trim() ?? "";
		if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/.test(head)) {
			const parenIdx = head.indexOf("(");
			const args = extractBalanced(head, parenIdx, "(", ")");
			if (args.length > 2) {
				for (const arg of splitTopLevelArgs(args.slice(1, -1))) {
					if (isOptional(arg, ctx, depth + 1)) return true;
				}
			}
		}
	}
	return false;
}

/**
 * Coerce a Zod numeric-constraint argument (`.min(n)`, `.max(n)`, `.length(n)`)
 * to a finite number, or `null` when it is not a numeric literal — e.g. a
 * minified variable the walker cannot resolve. Callers drop the constraint on
 * `null` rather than emit a `NaN`/`null` JSON Schema keyword that Ajv rejects.
 */
function numericArg(arg: string | undefined): number | null {
	if (arg === undefined) return null;
	const n = Number(arg.trim());
	return Number.isFinite(n) ? n : null;
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
		case "min": {
			// Only emit the constraint when the bound resolves to a real number.
			// Minified releases sometimes pass a variable (e.g. `.max(someVar)`)
			// the walker can't resolve; `Number()` would yield NaN → an invalid
			// (`null`) JSON Schema keyword. Drop it rather than emit garbage.
			const n = numericArg(args[0]);
			if (n === null) return schema;
			if (schema.type === "string") return { ...schema, minLength: n };
			if (schema.type === "array") return { ...schema, minItems: n };
			return { ...schema, minimum: n };
		}
		case "max": {
			const n = numericArg(args[0]);
			if (n === null) return schema;
			if (schema.type === "string") return { ...schema, maxLength: n };
			if (schema.type === "array") return { ...schema, maxItems: n };
			return { ...schema, maximum: n };
		}
		case "length": {
			const n = numericArg(args[0]);
			if (n === null) return schema;
			if (schema.type === "string")
				return { ...schema, minLength: n, maxLength: n };
			if (schema.type === "array")
				return { ...schema, minItems: n, maxItems: n };
			return schema;
		}
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
	return findSymbolSiteByAnchor(index, anchorText)?.name ?? null;
}

/**
 * `findSymbolByAnchor`, but also reporting which module the binding it walked
 * back to sits in.
 *
 * The walk-back lands on the symbol's actual `=<lazyWrapper>(()=>` declaration,
 * so that module is not a guess: it is where this schema is defined, and every
 * symbol the definition goes on to reference must be resolved against it.
 */
export function findSymbolSiteByAnchor(
	index: DefinitionIndex,
	anchorText: string,
): { name: string; module: number } | null {
	const { source, lazyWrapper } = index;
	const anchorIdx = source.indexOf(anchorText);
	if (anchorIdx === -1) return null;
	const eq = source.lastIndexOf(`=${lazyWrapper}(()=>`, anchorIdx);
	if (eq === -1) return null;
	let nameEnd = eq;
	let nameStart = nameEnd;
	while (nameStart > 0 && /[\w$]/.test(source[nameStart - 1])) nameStart--;
	if (nameStart === nameEnd) return null;
	return {
		name: source.slice(nameStart, nameEnd),
		module: moduleOfOffset(index.moduleRanges, eq),
	};
}

/**
 * Build the `.lsp.json` schema. Shape: record of server-name → RSH (the
 * per-server strict object). Matches Claude Code's runtime validator
 * `E.record(E.string(), RSH()).safeParse(content)`.
 */
export function buildLspSchema(index: DefinitionIndex): JSONSchema | null {
	const rsh = findSymbolSiteByAnchor(
		index,
		"extensionToLanguage must have at least one mapping",
	);
	if (!rsh) return null;
	const site = resolveDefSite(index, rsh.name, rsh.module);
	if (!site) return null;
	const rshSchema = evalZod(site.value, {
		index,
		resolving: new Set(),
		module: site.module,
	});
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
	const vc8 = findSymbolSiteByAnchor(
		index,
		"Monitor names must be unique within a plugin",
	);
	if (!vc8) return null;
	const site = resolveDefSite(index, vc8.name, vc8.module);
	if (!site) return null;
	const arrSchema = evalZod(site.value, {
		index,
		resolving: new Set(),
		module: site.module,
	});
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
	const schema = evalZod(expr, {
		index,
		resolving: new Set(),
		module: moduleOfOffset(index.moduleRanges, headStart),
	});

	if (schema.type !== "object") return null;
	// Safety: the settings schema must never reject unknown top-level keys.
	if (schema.additionalProperties === false) {
		delete (schema as Record<string, unknown>).additionalProperties;
	}
	// Safety: settings.json has no required keys — every field is optional and
	// `{}` is a valid settings file. Anything the walker reports as required is
	// therefore an extraction artefact, not a contract, and emitting it makes
	// the linter reject configs Claude Code accepts. On 2.1.259 the corpus
	// binds `cc` in fourteen modules, so `autoCompactWindow:cc()` resolved
	// through an unrelated module's non-optional definition and every valid
	// settings file failed `settings-json/schema-valid`. Asserting the
	// invariant is the fail-safe direction: a linter must never over-validate.
	delete (schema as Record<string, unknown>).required;

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
	const sym = findSymbolSiteByAnchor(index, anchor);
	if (!sym) return null;
	const site = resolveDefSite(index, sym.name, sym.module);
	if (!site) return null;
	const schema = evalZod(site.value, {
		index,
		resolving: new Set(),
		module: site.module,
	});
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
	const schema = evalZod(expr, {
		index,
		resolving: new Set(),
		module: moduleOfOffset(index.moduleRanges, objIdx),
	});
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
	//
	// `record` is accepted as a second anchor, and every occurrence is tried
	// rather than only the first: if a future Zod chunk stops distinguishing
	// `partialRecord` from `record` the mapping collapses to `record`, of which
	// a corpus holds hundreds. Walking them until one resolves to an object
	// keeps the schema extractable instead of silently dropping it.
	let hooksValue: JSONSchema | null = null;
	outer: for (const method of ["partialRecord", "record"]) {
		const anchor = `${index.zodAlias}.${method}(`;
		for (
			let anchorIdx = source.indexOf(anchor);
			anchorIdx !== -1;
			anchorIdx = source.indexOf(anchor, anchorIdx + 1)
		) {
			// Walk back to the enclosing `=<lazyWrapper>(()=>` and read the symbol.
			const eq = source.lastIndexOf(`=${lazyWrapper}(()=>`, anchorIdx);
			if (eq === -1) continue;
			let nameStart = eq;
			while (nameStart > 0 && /[\w$]/.test(source[nameStart - 1])) nameStart--;
			const hcSym = source.slice(nameStart, eq);
			if (!hcSym) continue;
			// The declaration this anchor sits inside fixes the module, so the
			// symbol resolves to that module's binding rather than to whichever
			// module the concatenation put first.
			const hcModule = moduleOfOffset(index.moduleRanges, eq);
			const hcSite = resolveDefSite(index, hcSym, hcModule);
			// The symbol must be the one this anchor belongs to, not a nearer
			// unrelated factory that happens to precede it.
			if (!hcSite || !hcSite.value.includes(anchor)) continue;
			const candidate = evalZod(hcSite.value, {
				index,
				resolving: new Set(),
				module: hcSite.module,
			});
			if (candidate.type !== "object") continue;
			hooksValue = candidate;
			break outer;
		}
	}
	if (!hooksValue) return null;
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
	const master = findMasterSchemaSite(index);
	if (!master) {
		throw new Error(
			"Could not locate master plugin schema (kebab-case anchor not found)",
		);
	}
	const masterSite = resolveDefSite(index, master.name, master.module);
	if (!masterSite) {
		throw new Error(`Master schema symbol ${master.name} has no definition`);
	}
	const refs = parseMasterSpread(
		masterSite.value,
		index.zodAlias,
		index.lazyWrapper,
	);
	if (refs.length === 0) {
		throw new Error("Master schema spread parsing returned 0 refs");
	}

	const properties: Record<string, JSONSchema> = {};
	const required: string[] = [];
	// The spread refs are written inside the master's own definition, so they
	// are that module's names — not the naming call site's, and not the
	// corpus's.
	const ctx: EvalContext = {
		index,
		resolving: new Set(),
		module: masterSite.module,
	};

	for (const ref of refs) {
		const site = resolveDefSite(index, ref.name, ctx.module);
		if (!site) continue;
		const sub = evalZod(
			site.value,
			site.module === ctx.module ? ctx : { ...ctx, module: site.module },
		);
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
// 8. Drift gate
// ---------------------------------------------------------------------------

/**
 * Fraction of the previous extraction's property paths a schema may lose before
 * the run is treated as broken rather than as upstream churn.
 *
 * One rule for all nine schemas. The alternative considered and rejected was a
 * per-schema hand-tuned threshold: it encodes today's field counts, and it rots
 * silently as Claude Code churns. A ratio scales with the schema by
 * construction, which is the same strictness with no table to maintain.
 */
const SCHEMA_DROP_LIMIT = 0.3;

/**
 * Every property path in a JSON Schema tree, e.g. `/hooks/PreToolUse/matcher`.
 *
 * Counting *top-level* `properties` — what the gate used to do — cannot work
 * across these nine schemas: `.lsp.json` is a record and `monitors.json` an
 * array, so both have zero top-level properties and a top-level rule can never
 * fire on them; `hooks.json` and `.mcp.json` have exactly one, so it fires only
 * on total annihilation. Measured on 2.1.259 the top-level counts are
 * 0/0/1/1/13/20/28/42/169, while the path counts are 4/13/13/21/42/48/87/356/616
 * — a denominator that exists for every schema and tracks its real size.
 *
 * Recursing through `items`/`additionalProperties`/`oneOf`/… is what makes the
 * collapse this gate is for visible: an unresolved symbol degrades a subtree to
 * a permissive `{}`, which erases paths wholesale while leaving the top level
 * untouched.
 */
export function schemaPropertyPaths(
	node: unknown,
	prefix = "",
	out: Set<string> = new Set(),
): Set<string> {
	if (Array.isArray(node)) return out;
	if (!node || typeof node !== "object") return out;
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (key === "properties" && value && typeof value === "object") {
			for (const [propName, propValue] of Object.entries(
				value as Record<string, unknown>,
			)) {
				const path = `${prefix}/${propName}`;
				out.add(path);
				schemaPropertyPaths(propValue, path, out);
			}
		} else if (
			(key === "items" || key === "additionalProperties" || key === "not") &&
			value &&
			typeof value === "object"
		) {
			schemaPropertyPaths(value, `${prefix}/${key}`, out);
		} else if (
			(key === "oneOf" ||
				key === "anyOf" ||
				key === "allOf" ||
				key === "prefixItems") &&
			Array.isArray(value)
		) {
			value.forEach((branch, i) =>
				schemaPropertyPaths(branch, `${prefix}/${key}[${i}]`, out),
			);
		} else if (
			(key === "$defs" ||
				key === "definitions" ||
				key === "patternProperties") &&
			value &&
			typeof value === "object"
		) {
			for (const [defName, defValue] of Object.entries(
				value as Record<string, unknown>,
			)) {
				schemaPropertyPaths(defValue, `${prefix}/${key}/${defName}`, out);
			}
		}
	}
	return out;
}

/** The `schema` of a previously written contracts file, or null when absent. */
function readPreviousSchema(outPath: string): JSONSchema | null {
	try {
		const prev = JSON.parse(readFileSync(outPath, "utf8")) as {
			schema?: JSONSchema;
		};
		return prev.schema ?? null;
	} catch {
		return null; // no previous file — first run
	}
}

/**
 * Compare a freshly built schema against the committed one and abort the run
 * when too much of it vanished.
 *
 * Applied to EVERY emitted schema, not just `plugin.schema.json`. Gating one of
 * nine let the frontmatter schemas silently go 42 → 7, 20 → 7 and 13 → 7 fields
 * (83% loss) with the run exiting 0 — the failure mode a drift gate exists to
 * make impossible.
 *
 * `FORCE_SCHEMA=1` overrides, unchanged, for a loss that is genuinely upstream.
 */
export interface DriftVerdict {
	/** Property paths present before and gone now. */
	lost: string[];
	/** Property paths that are new. */
	gained: string[];
	/** Size of the previous extraction's path set — the denominator. */
	prevCount: number;
	/** `lost.length / prevCount`, or 0 when there was nothing to compare to. */
	dropRate: number;
	/** True when the loss exceeds the limit and the run should fail. */
	fatal: boolean;
}

/**
 * The drift decision, as a value — no I/O, no `process.exit`.
 *
 * Split out so the gate's own behaviour is testable, including the cases that
 * must NOT fire (no previous extraction, a previous extraction that was already
 * empty) and the case that must (a subtree collapsing). A gate whose failure
 * paths are only reachable through `process.exit` is a gate nothing checks.
 */
export function schemaDriftVerdict(
	prevSchema: JSONSchema | null,
	schema: JSONSchema,
	limit: number = SCHEMA_DROP_LIMIT,
): DriftVerdict {
	const empty: DriftVerdict = {
		lost: [],
		gained: [],
		prevCount: 0,
		dropRate: 0,
		fatal: false,
	};
	if (!prevSchema) return empty;
	const prevPaths = schemaPropertyPaths(prevSchema);
	// Nothing to measure against: a previous extraction that carried no paths
	// cannot tell us anything was lost. Reported as "no verdict", not as "fine".
	if (prevPaths.size === 0) return empty;
	const nowPaths = schemaPropertyPaths(schema);
	const lost = [...prevPaths].filter((p) => !nowPaths.has(p)).sort();
	const gained = [...nowPaths].filter((p) => !prevPaths.has(p)).sort();
	const dropRate = lost.length / prevPaths.size;
	return {
		lost,
		gained,
		prevCount: prevPaths.size,
		dropRate,
		fatal: dropRate > limit,
	};
}

function checkSchemaDrift(
	label: string,
	outPath: string,
	schema: JSONSchema,
): void {
	const verdict = schemaDriftVerdict(readPreviousSchema(outPath), schema);
	if (verdict.gained.length > 0) {
		console.log(
			pc.green(
				`  + ${label} gained ${verdict.gained.length}: ${verdict.gained.slice(0, 12).join(", ")}`,
			),
		);
	}
	if (verdict.lost.length === 0) return;
	const msg =
		`${label} lost ${verdict.lost.length}/${verdict.prevCount} property paths ` +
		`(${(verdict.dropRate * 100).toFixed(0)}%): ${verdict.lost.slice(0, 12).join(", ")}`;
	if (verdict.fatal && process.env.FORCE_SCHEMA !== "1") {
		console.log(pc.red(`  ✗ ${msg}`));
		console.log(pc.red("    Set FORCE_SCHEMA=1 to override."));
		process.exit(1);
	}
	console.log(pc.yellow(`  ⚠ ${msg}`));
}

/**
 * Abort when a schema that previously extracted no longer builds at all.
 *
 * A builder returning null used to print a yellow warning and leave the stale
 * committed file in place — a total extraction failure reported more quietly
 * than a partial one, and invisible in an exit-0 run. Losing 100% of a schema
 * cannot be less serious than losing 31% of it, so it fails the same way.
 */
export function missingSchemaIsFatal(prevSchema: JSONSchema | null): boolean {
	return !!prevSchema && schemaPropertyPaths(prevSchema).size > 0;
}

function checkSchemaStillBuilds(label: string, outPath: string): void {
	const prevSchema = readPreviousSchema(outPath);
	if (!missingSchemaIsFatal(prevSchema)) {
		console.log(pc.yellow(`  ⚠ Could not locate ${label} schema`));
		return;
	}
	const prevCount = schemaPropertyPaths(prevSchema).size;
	if (process.env.FORCE_SCHEMA === "1") {
		console.log(
			pc.yellow(
				`  ⚠ ${label} schema no longer extracts (previous extraction kept; FORCE_SCHEMA=1)`,
			),
		);
		return;
	}
	console.log(
		pc.red(
			`  ✗ ${label} schema no longer extracts, but ${outPath} holds a previous ` +
				`extraction with ${prevCount} property paths — the anchor has moved.`,
		),
	);
	console.log(pc.red("    Set FORCE_SCHEMA=1 to override."));
	process.exit(1);
}

/** Write one extracted schema to its contracts file. */
function writeSchemaFile(
	outPath: string,
	version: string,
	schema: JSONSchema,
): void {
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				extractedFromClaudeCodeVersion: version,
				extractedAt: new Date().toISOString(),
				schema,
			},
			null,
			"\t",
		) + "\n",
	);
}

// ---------------------------------------------------------------------------
// 9. Main
// ---------------------------------------------------------------------------

function main() {
	const versionIdx = process.argv.indexOf("--version");
	const requestedVersion =
		versionIdx !== -1 ? process.argv[versionIdx + 1] : undefined;
	const localIdx = process.argv.indexOf("--local");
	const localBundle = localIdx !== -1 ? process.argv[localIdx + 1] : undefined;
	// `--only <comma-list>` restricts which schemas are (re)generated. Targets:
	// plugin, lsp, monitors, settings, frontmatter, mcp, hooks. Absent → all.
	// Used to regenerate just the frontmatter schemas from a local bundle whose
	// minification differs from the npm tarball the other schemas anchor on.
	const onlyIdx = process.argv.indexOf("--only");
	const onlySet =
		onlyIdx !== -1
			? new Set(
					process.argv[onlyIdx + 1]
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				)
			: null;
	const shouldBuild = (target: string): boolean =>
		onlySet === null || onlySet.has(target);
	let source: string;
	let version: string;
	let moduleRanges: ModuleRange[];
	if (localBundle) {
		console.log(
			pc.cyan(`▸ Loading local Claude Code bundle (${localBundle})...`),
		);
		({ source, version, moduleRanges } = loadLocalBundle(localBundle));
	} else {
		const label = requestedVersion ? `v${requestedVersion}` : "latest";
		console.log(
			pc.cyan(`▸ Fetching @anthropic-ai/claude-code (${label})...`),
		);
		({ source, version, moduleRanges } = fetchBundle(requestedVersion));
	}
	console.log(
		pc.cyan("▸ Indexing definitions"),
		pc.dim(`(v${version}, ${(source.length / 1e6).toFixed(1)}MB)`),
	);

	const index = indexDefinitions(source, moduleRanges);
	console.log(
		pc.dim(
			`  ${index.defs.size} definitions across ${moduleRanges.length} module(s), ` +
				`Zod alias = ${index.zodAlias}`,
		),
	);
	assertDefinitionsUsable(index);

	const rootDir = join(import.meta.dirname!, "..");

	if (shouldBuild("plugin")) {
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

		const outPath = join(rootDir, "contracts", "plugin.schema.json");
		checkSchemaDrift("Plugin schema", outPath, schema);
		writeSchemaFile(outPath, version, schema);
		console.log(pc.dim(`  Written to ${outPath}`));
	}

	// Every other emitted schema, driven off one table so the drift gate cannot
	// be attached to some of them and forgotten on the rest — which is exactly
	// how the frontmatter schemas lost 83% of their fields inside a green run.
	const targets: Array<{
		key: string;
		label: string;
		file: string;
		build: (i: DefinitionIndex) => JSONSchema | null;
	}> = [
		{
			key: "lsp",
			label: "LSP",
			file: "lsp.schema.json",
			build: buildLspSchema,
		},
		{
			key: "monitors",
			label: "Monitors",
			file: "monitors.schema.json",
			build: buildMonitorsSchema,
		},
		{
			key: "settings",
			label: "Settings",
			file: "settings.schema.json",
			build: buildSettingsSchema,
		},
		{
			key: "frontmatter",
			label: "Skill frontmatter",
			file: "skill-frontmatter.schema.json",
			build: buildSkillFrontmatterSchema,
		},
		{
			key: "frontmatter",
			label: "Agent frontmatter",
			file: "agent-frontmatter.schema.json",
			build: buildAgentFrontmatterSchema,
		},
		{
			key: "frontmatter",
			label: "Command frontmatter",
			file: "command-frontmatter.schema.json",
			build: buildCommandFrontmatterSchema,
		},
		{
			key: "mcp",
			label: "MCP config",
			file: "mcp.schema.json",
			build: buildMcpJsonSchema,
		},
		{
			key: "hooks",
			label: "Hooks config",
			file: "hooks.schema.json",
			build: buildHooksJsonSchema,
		},
	];
	for (const target of targets) {
		if (!shouldBuild(target.key)) continue;
		const outPath = join(rootDir, "contracts", target.file);
		const schema = target.build(index);
		if (!schema) {
			checkSchemaStillBuilds(target.label, outPath);
			continue;
		}
		checkSchemaDrift(`${target.label} schema`, outPath, schema);
		writeSchemaFile(outPath, version, schema);
		console.log(
			pc.cyan(
				`▸ ${target.label} schema written to ${outPath} ` +
					`(${schemaPropertyPaths(schema).size} property paths)`,
			),
		);
	}
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	main();
}
