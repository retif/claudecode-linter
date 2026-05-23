/**
 * Lazy loader for the auto-extracted plugin.json JSON Schema. The schema lives
 * at `contracts/plugin.schema.json` (extracted from Claude Code's cli.js by
 * `scripts/extract-plugin-schema.ts`).
 *
 * Resolution: from dist/plugin-schema.js (compiled), step up two directories to
 * reach the package root where `contracts/` lives. Falls back to the package
 * resolver if the file is being run from an alternate layout (e.g. monorepo).
 */

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
// biome-ignore lint/style/useImportType: runtime import; types only.
import * as addFormatsNs from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { assetCandidates } from "./utils/asset-path.js";

// ajv-formats ships as CJS with a default function export. Under Node16
// ESM resolution we have to reach in for `.default`.
const addFormats = (
	addFormatsNs as unknown as {
		default: (ajv: unknown) => unknown;
	}
).default;

export interface PluginSchemaContext {
	validate: ValidateFunction;
	extractedFromVersion: string;
	/** Top-level plugin.json field names declared in the schema. */
	knownFields: ReadonlySet<string>;
}

export interface CompiledSchema {
	validate: ValidateFunction;
	extractedFromVersion: string;
	/** Top-level property names declared in the schema (empty for record/array roots). */
	knownFields: ReadonlySet<string>;
}

let cached: PluginSchemaContext | null = null;
const compiledCache = new Map<string, CompiledSchema | null>();
let ajvShared: Ajv2020 | null = null;

function getAjv(): Ajv2020 {
	if (ajvShared) return ajvShared;
	ajvShared = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajvShared);
	return ajvShared;
}

type SchemaShape =
	| { extractedFromClaudeCodeVersion: string; schema: Record<string, unknown> }
	| Record<string, unknown>;

function tryReadFile(relPath: string[]): string | null {
	const candidates = [
		...assetCandidates(import.meta.url, ["..", ...relPath]),
		...assetCandidates(import.meta.url, ["..", "..", ...relPath]),
	];
	for (const p of candidates) {
		try {
			return readFileSync(p, "utf8");
		} catch {
			// try next
		}
	}
	return null;
}

/**
 * Compile a schema document, handling both wrapper shapes:
 *   - extracted (`{ extractedFromClaudeCodeVersion, schema: {...} }`)
 *   - bare JSON Schema (the schemastore.org files, no envelope)
 */
function compileSchemaDoc(
	raw: string,
	sourceLabel: string,
): CompiledSchema {
	const parsed = JSON.parse(raw) as SchemaShape;
	let schema: Record<string, unknown>;
	let version: string;
	if (
		"extractedFromClaudeCodeVersion" in parsed &&
		typeof parsed.extractedFromClaudeCodeVersion === "string" &&
		"schema" in parsed &&
		typeof parsed.schema === "object" &&
		parsed.schema !== null
	) {
		schema = parsed.schema as Record<string, unknown>;
		version = parsed.extractedFromClaudeCodeVersion;
	} else {
		// Bare schemastore document. Strip `$id` (Ajv registers it globally
		// and trips `$id already exists` on a second compile) and any
		// `$schema` meta-pointer Ajv2020 can't resolve (draft-07 etc.).
		const { $id: _id, $schema: _meta, ...rest } = parsed as Record<
			string,
			unknown
		>;
		void _id;
		void _meta;
		schema = rest;
		version = sourceLabel;
	}
	const propSrc =
		(schema.properties as Record<string, unknown> | undefined) ?? {};
	return {
		validate: getAjv().compile(schema),
		extractedFromVersion: version,
		knownFields: new Set(Object.keys(propSrc)),
	};
}

function loadCompiledSchema(fileName: string): CompiledSchema | null {
	if (compiledCache.has(fileName)) return compiledCache.get(fileName) ?? null;
	const raw = tryReadFile(["contracts", fileName]);
	if (!raw) {
		compiledCache.set(fileName, null);
		return null;
	}
	const compiled = compileSchemaDoc(raw, fileName);
	compiledCache.set(fileName, compiled);
	return compiled;
}

/**
 * Load a schemastore.org-curated schema from `contracts/schemastore/`.
 * Schemastore is preferred for top-level artifact validation because it's
 * Anthropic's own published source of truth and stays stable across Claude
 * Code minifier rotations. The Zod-extracted schemas (`loadCompiledSchema`)
 * remain authoritative for sub-shapes schemastore doesn't enumerate.
 */
function loadSchemastoreSchema(fileName: string): CompiledSchema | null {
	const cacheKey = `schemastore/${fileName}`;
	if (compiledCache.has(cacheKey)) return compiledCache.get(cacheKey) ?? null;
	const raw = tryReadFile(["contracts", "schemastore", fileName]);
	if (!raw) {
		compiledCache.set(cacheKey, null);
		return null;
	}
	const compiled = compileSchemaDoc(raw, `schemastore:${fileName}`);
	compiledCache.set(cacheKey, compiled);
	return compiled;
}

export function loadLspSchema(): CompiledSchema | null {
	return loadCompiledSchema("lsp.schema.json");
}

export function loadMonitorsSchema(): CompiledSchema | null {
	return loadCompiledSchema("monitors.schema.json");
}

export function loadSettingsSchema(): CompiledSchema | null {
	// gitea#6: prefer the Zod-extracted schema (runtime truth, e.g.
	// `disableAutoMode` is `boolean` in 2.1.150) over schemastore (which
	// still lists it as a string literal — out of date). Schemastore is
	// only used for artifacts with no Zod source (marketplace, keybindings).
	return loadCompiledSchema("settings.schema.json");
}

/**
 * Marketplace and keybindings schemas come exclusively from schemastore —
 * there is no Zod source for them in the Claude Code bundle. Returns null
 * if the user's install was shipped without the schemastore bundle (rare;
 * the package.json includes them in `files`).
 */
export function loadMarketplaceSchema(): CompiledSchema | null {
	return loadSchemastoreSchema("marketplace.schema.json");
}

export function loadKeybindingsSchema(): CompiledSchema | null {
	return loadSchemastoreSchema("keybindings.schema.json");
}

export function loadMcpJsonSchema(): CompiledSchema | null {
	return loadCompiledSchema("mcp.schema.json");
}

export function loadHooksJsonSchema(): CompiledSchema | null {
	return loadCompiledSchema("hooks.schema.json");
}

export function loadSkillFrontmatterSchema(): CompiledSchema | null {
	return loadCompiledSchema("skill-frontmatter.schema.json");
}

export function loadAgentFrontmatterSchema(): CompiledSchema | null {
	return loadCompiledSchema("agent-frontmatter.schema.json");
}

export function loadCommandFrontmatterSchema(): CompiledSchema | null {
	return loadCompiledSchema("command-frontmatter.schema.json");
}

export function loadPluginSchema(): PluginSchemaContext | null {
	if (cached) return cached;

	// gitea#6: prefer the Zod-extracted plugin.schema.json (runtime truth);
	// schemastore copy stays committed at `contracts/schemastore/` for
	// reference and for the marketplace/keybindings artifacts only.
	const raw = tryReadFile(["contracts", "plugin.schema.json"]);
	if (!raw) return null;

	const compiled = compileSchemaDoc(raw, "plugin.schema.json");
	cached = {
		validate: compiled.validate,
		extractedFromVersion: compiled.extractedFromVersion,
		knownFields: compiled.knownFields,
	};
	return cached;
}

/**
 * Reduce Ajv's anyOf/oneOf branch enumeration to the "closest match" branch.
 *
 * When a value fails an anyOf with N branches, Ajv emits errors for every
 * branch — that's faithful but noisy (14 lines for one malformed MCP server).
 * We use schemaPath to group child errors by branch index and keep only the
 * branch with the fewest errors (the most-likely-intended shape).
 *
 * Nested unions are handled by processing outer unions first: their kept
 * branch's inner anyOf and inner children survive into the second pass, where
 * the inner union is itself summarized.
 */
export function summarizeErrors(errors: ErrorObject[]): ErrorObject[] {
	if (errors.length === 0) return errors;

	// Sort unions outermost-first (shorter schemaPath = closer to root).
	const unions = errors
		.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf")
		.sort((a, b) => a.schemaPath.length - b.schemaPath.length);

	const dropped = new Set<ErrorObject>();

	for (const union of unions) {
		// Children of this union have schemaPath starting with `<unionPath>/<N>/`.
		// AJV emits schemaPath like "#/properties/mcpServers/anyOf" for the union
		// summary and "#/properties/mcpServers/anyOf/2/required" for branch 2's
		// child errors.
		const prefix = `${union.schemaPath}/`;
		const children = errors.filter(
			(e) => e !== union && e.schemaPath.startsWith(prefix) && !dropped.has(e),
		);
		if (children.length === 0) continue;

		// Group by branch index (the segment right after the prefix).
		const byBranch = new Map<string, ErrorObject[]>();
		for (const c of children) {
			const branchIdx = c.schemaPath.slice(prefix.length).split("/", 1)[0];
			const arr = byBranch.get(branchIdx) ?? [];
			arr.push(c);
			byBranch.set(branchIdx, arr);
		}

		// Pick the branch the user got the furthest into. We measure "furthest"
		// as the depth of each branch's *shallowest* error: a branch that failed
		// only deep inside means we matched the outer shape (e.g. value is an
		// object, but a nested transport type is wrong) — strong signal of intent.
		// Counting errors flatly would mislead since nested anyOfs fan out.
		let bestBranch: string | null = null;
		let bestDepth = -1;
		for (const [branch, errs] of byBranch) {
			let minDepth = Infinity;
			for (const e of errs) {
				const depth = e.schemaPath
					.slice(prefix.length + branch.length + 1)
					.split("/").length;
				if (depth < minDepth) minDepth = depth;
			}
			if (minDepth > bestDepth) {
				bestDepth = minDepth;
				bestBranch = branch;
			}
		}

		// Drop every child of this union that isn't in the best branch.
		for (const [branch, errs] of byBranch) {
			if (branch === bestBranch) continue;
			for (const e of errs) dropped.add(e);
		}

		// The anyOf/oneOf parent error itself ("does not match any allowed shape")
		// is redundant once we've kept a branch-specific child error that points
		// to the actual problem. Drop it unless its best branch had nothing left.
		const survivingKept = bestBranch !== null
			? (byBranch.get(bestBranch) ?? []).filter((e) => !dropped.has(e))
			: [];
		if (survivingKept.length > 0) dropped.add(union);
	}

	// Final pass: drop the rejected branches and dedupe identical errors.
	const seen = new Set<string>();
	const out: ErrorObject[] = [];
	for (const e of errors) {
		if (dropped.has(e)) continue;
		const sig = `${e.instancePath}|${e.keyword}|${JSON.stringify(e.params)}`;
		if (seen.has(sig)) continue;
		seen.add(sig);
		out.push(e);
	}
	return out;
}

/** Format an Ajv error as a human-readable single-line message. */
export function formatAjvError(error: ErrorObject): string {
	const where = error.instancePath || "(root)";
	const params = error.params as Record<string, unknown>;
	switch (error.keyword) {
		case "required":
			return `${where}: missing required field "${params.missingProperty}"`;
		case "type":
			return `${where}: must be ${params.type}`;
		case "enum": {
			const allowed = (params.allowedValues as unknown[] | undefined) ?? [];
			return `${where}: must be one of [${allowed
				.map((v) => JSON.stringify(v))
				.join(", ")}]`;
		}
		case "const":
			return `${where}: must equal ${JSON.stringify(params.allowedValue)}`;
		case "additionalProperties":
			return `${where}: unknown property "${params.additionalProperty}"`;
		case "anyOf":
			return `${where}: does not match any allowed shape`;
		case "oneOf":
			return `${where}: does not match exactly one allowed shape`;
		case "pattern":
			return `${where}: does not match pattern ${params.pattern}`;
		case "minLength":
			return `${where}: must be at least ${params.limit} characters`;
		case "maxLength":
			return `${where}: must be at most ${params.limit} characters`;
		case "minItems":
			return `${where}: must have at least ${params.limit} items`;
		case "maxItems":
			return `${where}: must have at most ${params.limit} items`;
		default:
			return `${where}: ${error.message ?? error.keyword}`;
	}
}
