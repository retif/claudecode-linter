#!/usr/bin/env tsx
/**
 * Fetch the `es-tooling/module-replacements` manifests and commit them under
 * `contracts/module-replacements/`.
 *
 * `check-deps.ts` used to fetch these at CI run time, which made this repo's
 * gate a function of a third-party file nobody here edits: an upstream
 * addition turned `main` and every open PR red with no local change, and a
 * non-OK response was logged and skipped so the gate passed vacuously
 * (oleks/claudecode-linter#25). Vendoring makes the upstream edit arrive as a
 * reviewable diff instead of an outage, exactly as `fetch-schemastore.ts`
 * already does for schemastore.org.
 *
 * Run deliberately — manually, or by the weekly `refresh-module-replacements`
 * workflow, which opens a PR when the snapshot moves. Never wired into a
 * release or lint path: a refresh must be reviewed, not absorbed.
 *
 * Every failure here is fatal. A fetch that cannot complete must not leave a
 * stale-but-plausible snapshot silently in place, and must never be mistaken
 * for "nothing changed".
 *
 * Usage:
 *   npx tsx scripts/fetch-module-replacements.ts [--ref <git-ref>]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Manifest files consumed by `check-deps.ts`. */
export const MANIFEST_FILES = [
	"native.json",
	"micro-utilities.json",
	"preferred.json",
] as const;

/** Upstream ref to snapshot when `--ref` is not given. */
export const DEFAULT_REF = "main";

/** Directory (relative to the repo root) the snapshot is written to. */
export const SNAPSHOT_DIR = join("contracts", "module-replacements");

/** Filename of the provenance manifest written alongside the snapshots. */
export const PROVENANCE_FILE = "manifest.json";

export function manifestUrl(ref: string, file: string): string {
	return `https://raw.githubusercontent.com/es-tooling/module-replacements/${ref}/manifests/${file}`;
}

/**
 * Fetch one manifest body.
 *
 * Throws on any non-OK response. A rejected `fetch` (DNS failure, reset,
 * timeout) propagates unchanged. Neither is swallowed — that swallowing was
 * the defect this script exists to remove.
 */
export async function fetchManifestBody(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const res = await fetchImpl(url, {
		redirect: "follow",
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(
			`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`,
		);
	}
	return await res.text();
}

/**
 * Parse and structurally validate a manifest body.
 *
 * An empty `mappings` is rejected: a truncated or placeholder upstream file
 * would otherwise read as "no module is replaceable" and pass the gate for the
 * wrong reason.
 */
export function parseManifestBody(
	text: string,
	label: string,
): { mappings: Record<string, unknown> } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${label} is not a JSON object`);
	}
	const mappings = (parsed as Record<string, unknown>).mappings;
	if (
		mappings === null ||
		typeof mappings !== "object" ||
		Array.isArray(mappings)
	) {
		throw new Error(`${label} has no \`mappings\` object`);
	}
	if (Object.keys(mappings).length === 0) {
		throw new Error(
			`${label} has an empty \`mappings\` object — refusing to vendor a snapshot that would silently match nothing`,
		);
	}
	return parsed as { mappings: Record<string, unknown> };
}

export async function sha256(body: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(body),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function parseRefArg(argv: string[]): string {
	const idx = argv.indexOf("--ref");
	if (idx === -1) return DEFAULT_REF;
	const ref = argv[idx + 1];
	if (!ref || ref.startsWith("--")) {
		throw new Error("--ref requires a value (a branch, tag or commit SHA)");
	}
	return ref;
}

async function main(): Promise<void> {
	const ref = parseRefArg(process.argv.slice(2));
	const rootDir = join(import.meta.dirname!, "..");
	const outDir = join(rootDir, SNAPSHOT_DIR);
	mkdirSync(outDir, { recursive: true });

	const sources: Record<
		string,
		{ url: string; sha256: string; mappings: number }
	> = {};

	for (const file of MANIFEST_FILES) {
		const url = manifestUrl(ref, file);
		process.stdout.write(`▸ Fetching ${url} ... `);
		const text = await fetchManifestBody(url);
		const parsed = parseManifestBody(text, file);
		const body = JSON.stringify(parsed, null, "\t");
		writeFileSync(join(outDir, file), body + "\n");
		sources[file] = {
			url,
			sha256: await sha256(body),
			mappings: Object.keys(parsed.mappings).length,
		};
		console.log(`${sources[file].mappings} mappings`);
	}

	writeFileSync(
		join(outDir, PROVENANCE_FILE),
		JSON.stringify(
			{
				source: "https://github.com/es-tooling/module-replacements",
				ref,
				fetchedAt: new Date().toISOString(),
				sources,
			},
			null,
			"\t",
		) + "\n",
	);

	console.log(`\nSnapshot written to ${SNAPSHOT_DIR}/ (ref: ${ref}).`);
	console.log(
		"Review the diff — a new entry matching a production dependency will fail `npm run check-deps`.",
	);
}

// Only run main() when executed directly, not when imported for testing
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	main().catch((e: unknown) => {
		console.error(`\nERROR: ${(e as Error).message}`);
		process.exit(1);
	});
}
