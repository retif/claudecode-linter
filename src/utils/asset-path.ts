/**
 * Resolve runtime assets (contracts/*.schema.json, .claudecode-lint.defaults.yaml,
 * package.json) that ship alongside the package on disk.
 *
 * Normally these are found relative to `import.meta.url` — the location of the
 * compiled `.js` file inside `dist/`. That works for the Node build and for the
 * published npm package.
 *
 * Inside a `bun build --compile` single-executable, `import.meta.url` points
 * into Bun's virtual embedded filesystem (`/$bunfs/...`), so disk reads of
 * sibling assets fail. To support that variant, we ALSO emit candidates
 * relative to `process.execPath` (the real on-disk path of the running
 * executable). The compiled-binary image ships `contracts/` and
 * `.claudecode-lint.defaults.yaml` next to the executable, so those fallback
 * candidates resolve there.
 *
 * For the Node runtime, the `process.execPath`-relative candidates simply point
 * at the `node` binary's directory and won't match — harmless extra lookups
 * appended AFTER the existing ones, so Node resolution is byte-for-byte
 * unchanged.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build a list of candidate paths for an asset shipped with the package.
 *
 * @param importMetaUrl  `import.meta.url` of the calling module.
 * @param segments       Path segments, relative to a base directory, that
 *                        locate the asset (e.g. `["..", "contracts", "x.json"]`
 *                        for a module under `dist/`).
 * @returns Ordered candidate paths: `import.meta.url`-relative first (existing
 *          behavior), then `process.execPath`-relative fallbacks.
 */
export function assetCandidates(
	importMetaUrl: string,
	segments: string[],
): string[] {
	const candidates: string[] = [];

	// 1. import.meta.url-relative — the existing, primary resolution.
	const here = dirname(fileURLToPath(importMetaUrl));
	candidates.push(resolve(here, ...segments));

	// 2. process.execPath-relative fallbacks for the compiled single-executable.
	//    The binary lives next to `contracts/` and the defaults YAML, so we try
	//    both the executable's own directory and one level up (mirroring the
	//    dist/ -> package-root step the segments encode).
	try {
		const execDir = dirname(process.execPath);
		// Drop leading ".." segments: assets sit directly beside the executable.
		const beside = segments.filter((s) => s !== "..");
		candidates.push(resolve(execDir, ...beside));
		candidates.push(resolve(execDir, ...segments));
	} catch {
		// process.execPath unavailable — ignore.
	}

	// De-duplicate while preserving order.
	return [...new Set(candidates)];
}
