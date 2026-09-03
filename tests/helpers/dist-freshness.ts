import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every TypeScript source under `srcDir`, as paths relative to it. tsc emits
 * one `.js` per source file (this project has no `.d.ts` inputs), so the list
 * is exactly the set of outputs `dist/` is expected to hold.
 */
export function listTsSources(srcDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
				out.push(relative(srcDir, full));
		}
	};
	if (existsSync(srcDir)) walk(srcDir);
	return out.sort();
}

const BUILD_HINT = "Run `npm run build` and re-run the tests.";

/**
 * Why `dist/` cannot be trusted to match `src/`, or null when it can.
 *
 * Tests that spawn the built CLI are only meaningful against a current build.
 * Without this check `npm test` validates whatever `dist/` happens to hold, so
 * a change to `src/` that breaks an assertion still reports green
 * (oleks/claudecode-linter#35).
 *
 * mtime is the comparison because `dist/` is generated from `src/` and is not
 * tracked by git: after a build every output is newer than every input, and
 * anything that touches a source afterwards — an edit, a checkout, a merge —
 * makes it older again. That biases the check toward "rebuild", which is the
 * safe direction: a spurious rebuild costs seconds, a stale build costs a
 * false green.
 */
export function findStaleDistReason(root: string): string | null {
	const srcDir = join(root, "src");
	const distDir = join(root, "dist");

	if (!existsSync(distDir)) return `dist/ does not exist. ${BUILD_HINT}`;

	for (const rel of listTsSources(srcDir)) {
		const relJs = rel.replace(/\.ts$/, ".js");
		const source = join(srcDir, rel);
		const output = join(distDir, relJs);

		if (!existsSync(output))
			return `dist/${relJs} is missing, but src/${rel} exists. ${BUILD_HINT}`;

		if (statSync(source).mtimeMs > statSync(output).mtimeMs)
			return `src/${rel} is newer than dist/${relJs} — the build is stale, so a test that spawns dist/ would be checking obsolete code. ${BUILD_HINT}`;
	}

	return null;
}

/** Throws {@link findStaleDistReason}'s message when `dist/` is not current. */
export function assertDistFresh(root: string): void {
	const reason = findStaleDistReason(root);
	if (reason !== null) throw new Error(reason);
}
