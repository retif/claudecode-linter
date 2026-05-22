import { lstatSync, realpathSync } from "node:fs";
import { sep } from "node:path";

/**
 * Decide whether writing to `filePath` (a fix/format target) is safe.
 *
 * The linter may write fixes back to artifact paths supplied by a plugin.
 * A malicious plugin can ship an artifact path that is actually a symlink
 * pointing outside the target tree (`~/.bashrc`, an SSH key, a CI secret);
 * a bare `writeFileSync` would then clobber the symlink's target.
 *
 * Returns a human-readable reason to REFUSE the write, or `null` if the
 * write is safe. The check fails closed: if anything throws (path missing,
 * permission error, etc.) a refusal reason is returned.
 *
 * Refuses when:
 *  - `filePath` itself is a symbolic link, or
 *  - the real path of `filePath` is not `rootDir` itself and not located
 *    under `rootDir + path.sep`.
 */
export function writeBlockedReason(
	filePath: string,
	rootDir: string,
): string | null {
	try {
		if (lstatSync(filePath).isSymbolicLink()) {
			return "path is a symlink";
		}
		const realRoot = realpathSync(rootDir);
		const realPath = realpathSync(filePath);
		if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
			return "path resolves outside the target directory";
		}
		return null;
	} catch {
		return "path could not be safely resolved";
	}
}
