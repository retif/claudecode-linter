#!/usr/bin/env tsx
/**
 * Check dependencies against the vendored `es-tooling/module-replacements`
 * snapshot in `contracts/module-replacements/`.
 *
 * Exits 1 if any production dependency is listed as replaceable. Dev
 * dependency matches are reported as warnings but don't fail.
 *
 * This reads a committed snapshot rather than fetching at run time
 * (oleks/claudecode-linter#25). Two properties follow, and both are the point:
 *
 *   - An upstream edit cannot redden `main` and every open PR with no local
 *     change. It arrives as a reviewable diff via
 *     `scripts/fetch-module-replacements.ts`.
 *   - The gate cannot pass vacuously. The old code logged a non-OK response
 *     and `continue`d, so a network blip skipped a whole manifest and the
 *     check reported success having compared nothing. Here every way of
 *     failing to load a manifest — missing file, unreadable, malformed JSON,
 *     no `mappings`, empty `mappings` — is fatal.
 *
 * Refresh the snapshot with: npm run fetch-module-replacements
 *
 * Usage: npx tsx scripts/check-deps.ts
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	MANIFEST_FILES,
	SNAPSHOT_DIR,
	parseManifestBody,
} from "./fetch-module-replacements.js";

export interface Mapping {
	moduleName?: string;
	replacements?: string[];
}

export type Mappings = Record<string, Mapping>;

export interface Finding {
	dep: string;
	manifest: string;
	dev: boolean;
	hint: string;
}

export interface CheckResult {
	prodFound: number;
	devFound: number;
	findings: Finding[];
}

/**
 * Load one vendored manifest.
 *
 * Every failure throws. A manifest that cannot be read is not "no matches" —
 * it is an unusable gate, and saying so loudly is the whole contract.
 */
export function loadManifest(dir: string, file: string): Mappings {
	const path = join(dir, file);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`Cannot read vendored manifest ${path}: ${(e as Error).message}. ` +
				`Run \`npm run fetch-module-replacements\` to restore the snapshot.`,
		);
	}
	return parseManifestBody(text, path).mappings as Mappings;
}

function hintFor(entry: Mapping): string {
	return entry.replacements?.length
		? `→ replace with: ${entry.replacements.join(", ")}`
		: "→ can be removed";
}

/** Pure comparison of declared dependencies against loaded manifests. */
export function checkDeps(
	prodDeps: string[],
	devDeps: string[],
	manifests: Array<{ file: string; mappings: Mappings }>,
): CheckResult {
	const findings: Finding[] = [];
	let prodFound = 0;
	let devFound = 0;

	for (const { file, mappings } of manifests) {
		for (const dep of prodDeps) {
			if (Object.hasOwn(mappings, dep)) {
				prodFound++;
				findings.push({
					dep,
					manifest: file,
					dev: false,
					hint: hintFor(mappings[dep]),
				});
			}
		}
		for (const dep of devDeps) {
			if (Object.hasOwn(mappings, dep)) {
				devFound++;
				findings.push({
					dep,
					manifest: file,
					dev: true,
					hint: hintFor(mappings[dep]),
				});
			}
		}
	}

	return { prodFound, devFound, findings };
}

/** Load every vendored manifest, failing closed on the first unusable one. */
export function loadAllManifests(
	dir: string,
	files: readonly string[] = MANIFEST_FILES,
): Array<{ file: string; mappings: Mappings }> {
	if (files.length === 0) {
		throw new Error(
			"No manifests configured — refusing to run a dependency gate that compares nothing",
		);
	}
	return files.map((file) => ({ file, mappings: loadManifest(dir, file) }));
}

function main(): void {
	const rootDir = join(import.meta.dirname!, "..");
	const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
	const prodDeps = Object.keys(pkg.dependencies ?? {});
	const devDeps = Object.keys(pkg.devDependencies ?? {});

	// Overridable so the fail-closed paths can be exercised end-to-end
	// against a fixture directory rather than the repo's own snapshot.
	const snapshotDir =
		process.env.CHECK_DEPS_SNAPSHOT_DIR ?? join(rootDir, SNAPSHOT_DIR);
	const manifests = loadAllManifests(snapshotDir);
	const { prodFound, devFound, findings } = checkDeps(
		prodDeps,
		devDeps,
		manifests,
	);

	for (const f of findings) {
		const label = f.dev ? `  warn  ${f.dep} [dev]` : `  ERROR ${f.dep}`;
		console.log(`${label} (${f.manifest}): ${f.hint}`);
	}

	if (prodFound > 0 || devFound > 0) {
		const parts: string[] = [];
		if (prodFound > 0) parts.push(`${prodFound} production`);
		if (devFound > 0) parts.push(`${devFound} dev`);
		console.log(`\n${parts.join(", ")} replaceable dependency(s) found.`);
	}

	if (prodFound > 0) {
		process.exit(1);
	} else if (devFound > 0) {
		console.log("Dev dependency warnings only — not blocking CI.");
	} else {
		console.log("No replaceable dependencies found.");
	}
}

// Only run main() when executed directly, not when imported for testing
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
	try {
		main();
	} catch (e: unknown) {
		console.error(`ERROR: ${(e as Error).message}`);
		process.exit(1);
	}
}
