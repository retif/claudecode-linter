#!/usr/bin/env tsx
/**
 * Fetch the canonical Claude Code JSON Schemas from schemastore.org and
 * commit them under `contracts/schemastore/`.
 *
 * schemastore.org is Anthropic's curated public source of truth for
 * Claude Code configuration shapes. We use it as the *primary* source the
 * linter validates against, with the Zod-derived schemas in `contracts/`
 * (extracted by `extract-plugin-schema.ts`) acting as a fallback for
 * structural detail schemastore doesn't enumerate (permissions sub-keys,
 * sandbox network/filesystem fields, hook event union, …).
 *
 * Run alongside `extract-contracts` on every contract sync (manual + CI).
 * The fetched JSONs are committed so builds stay deterministic — we never
 * hit schemastore.org at lint time, only at extract time.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface SchemastoreSource {
	/** Local filename under `contracts/schemastore/`. */
	file: string;
	/** Upstream URL on schemastore.org. */
	url: string;
	/** Which Claude Code artifact this schema describes. */
	artifact:
		| "plugin-json"
		| "marketplace-json"
		| "keybindings-json"
		| "settings-json";
}

const SOURCES: SchemastoreSource[] = [
	{
		file: "plugin-manifest.schema.json",
		url: "https://www.schemastore.org/claude-code-plugin-manifest.json",
		artifact: "plugin-json",
	},
	{
		file: "marketplace.schema.json",
		url: "https://www.schemastore.org/claude-code-marketplace.json",
		artifact: "marketplace-json",
	},
	{
		file: "keybindings.schema.json",
		url: "https://www.schemastore.org/claude-code-keybindings.json",
		artifact: "keybindings-json",
	},
	{
		file: "settings.schema.json",
		url: "https://www.schemastore.org/claude-code-settings.json",
		artifact: "settings-json",
	},
];

async function fetchOne(src: SchemastoreSource): Promise<unknown> {
	const res = await fetch(src.url, {
		redirect: "follow",
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(
			`Failed to fetch ${src.url}: HTTP ${res.status} ${res.statusText}`,
		);
	}
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(
			`Schemastore response for ${src.url} is not valid JSON: ${(e as Error).message}`,
		);
	}
	// Sanity check: every JSON Schema should at minimum have a $schema or
	// $id field, or be a non-empty object with `type`/`properties`. We
	// don't run a full meta-schema validation here — Ajv does that at lint
	// time when the schema is loaded.
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed)
	) {
		throw new Error(`Schemastore response for ${src.url} is not an object`);
	}
	const obj = parsed as Record<string, unknown>;
	const looksLikeSchema =
		"$schema" in obj ||
		"$id" in obj ||
		"type" in obj ||
		"properties" in obj ||
		"oneOf" in obj ||
		"anyOf" in obj;
	if (!looksLikeSchema) {
		throw new Error(
			`Schemastore response for ${src.url} does not look like a JSON Schema (no $schema/$id/type/properties)`,
		);
	}
	return parsed;
}

async function main(): Promise<void> {
	const rootDir = join(import.meta.dirname!, "..");
	const outDir = join(rootDir, "contracts", "schemastore");
	mkdirSync(outDir, { recursive: true });

	const fetchedAt = new Date().toISOString();
	const manifest: Record<
		string,
		{ url: string; artifact: string; sha256: string }
	> = {};

	for (const src of SOURCES) {
		process.stdout.write(`▸ Fetching ${src.url} ... `);
		const schema = await fetchOne(src);
		const body = JSON.stringify(schema, null, "\t");
		const outPath = join(outDir, src.file);
		writeFileSync(outPath, body + "\n");
		const sha = await crypto.subtle
			.digest("SHA-256", new TextEncoder().encode(body))
			.then((buf) =>
				Array.from(new Uint8Array(buf))
					.map((b) => b.toString(16).padStart(2, "0"))
					.join(""),
			);
		manifest[src.file] = {
			url: src.url,
			artifact: src.artifact,
			sha256: sha,
		};
		console.log(`OK (${(body.length / 1024).toFixed(1)} KB, sha256 ${sha.slice(0, 12)}…)`);
	}

	const manifestPath = join(outDir, "manifest.json");
	writeFileSync(
		manifestPath,
		JSON.stringify({ fetchedAt, sources: manifest }, null, "\t") + "\n",
	);
	console.log(`\n✔ Wrote ${SOURCES.length} schemas + manifest to contracts/schemastore/`);
}

main().catch((e) => {
	console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
