#!/usr/bin/env tsx
/**
 * Check production dependencies against the module-replacements list.
 * Exits with code 1 if any replaceable modules are found.
 *
 * Usage: npx tsx scripts/check-deps.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
	readFileSync(join(__dirname, "..", "package.json"), "utf8"),
);
const deps = Object.keys(pkg.dependencies ?? {});

const BASE =
	"https://raw.githubusercontent.com/es-tooling/module-replacements/main/manifests";
const manifests = ["native.json", "micro-utilities.json", "preferred.json"];

interface Mapping {
	moduleName: string;
	replacements?: string[];
}

let found = 0;

for (const name of manifests) {
	const res = await fetch(`${BASE}/${name}`);
	if (!res.ok) {
		console.error(`Failed to fetch ${name}: ${res.status}`);
		continue;
	}
	const data = (await res.json()) as { mappings: Record<string, Mapping> };
	const mappings = data.mappings ?? {};

	for (const dep of deps) {
		if (dep in mappings) {
			found++;
			const entry = mappings[dep];
			const hint = entry.replacements?.length
				? `→ replace with: ${entry.replacements.join(", ")}`
				: "→ can be removed";
			console.log(`  ${dep} (${name}): ${hint}`);
		}
	}
}

if (found > 0) {
	console.log(`\n${found} replaceable dependency(s) found.`);
	process.exit(1);
} else {
	console.log("No replaceable dependencies found.");
}
