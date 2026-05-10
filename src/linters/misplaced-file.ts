import { basename } from "node:path";
import { CANONICAL_ARTIFACTS } from "../canonical-paths.js";
import type {
	Linter,
	LintDiagnostic,
	LinterConfig,
	Severity,
} from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef {
	id: string;
	defaultSeverity: Severity;
}

export const MISPLACED_FILE_RULES: RuleDef[] = [
	{ id: "misplaced-file/canonical-location", defaultSeverity: "warning" },
];

/**
 * Flag files whose basename is reserved for a Claude Code artifact
 * but which sit at a non-canonical path. Claude Code reads each
 * artifact only from its canonical location and silently ignores
 * copies elsewhere, so this class of mistake is easy to make and
 * hard to debug — `/reload-plugins` reports `0 hooks` (or skills,
 * etc.) with no other signal.
 *
 * Discovery (see discovery.ts) populates this linter's inputs by
 * walking plugin trees and matching basenames; this linter just
 * emits one diagnostic per misplaced file with the expected
 * location.
 */
export const misplacedFileLinter: Linter = {
	artifactType: "misplaced-file",
	lint(
		filePath: string,
		_content: string,
		config: LinterConfig,
	): LintDiagnostic[] {
		const ruleId = "misplaced-file/canonical-location";
		if (!isRuleEnabled(config, ruleId)) return [];
		const base = basename(filePath);
		const entry = CANONICAL_ARTIFACTS.find((a) => a.basename === base);
		if (!entry) return [];
		const expected = entry.expectedPath ?? entry.expectedPattern ?? "";
		return [
			{
				rule: ruleId,
				severity: getRuleSeverity(config, ruleId, "warning"),
				message:
					`${base} is at a non-canonical path; ` +
					`Claude Code reads ${entry.description} only from ` +
					`\`${expected}\` (relative to plugin root) and ` +
					`silently ignores copies elsewhere. ` +
					`Move the file there or rename it.`,
				file: filePath,
			},
		];
	},
};
