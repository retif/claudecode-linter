import {
	formatAjvError,
	loadKeybindingsSchema,
	summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef {
	id: string;
	defaultSeverity: Severity;
}

export const KEYBINDINGS_JSON_RULES: RuleDef[] = [
	{ id: "keybindings-json/valid-json", defaultSeverity: "error" },
	{ id: "keybindings-json/schema-valid", defaultSeverity: "error" },
];

/**
 * Validate `~/.claude/keybindings.json` (or per-project `keybindings.json`)
 * against the schemastore.org curated schema. As with marketplace.json,
 * there is no Zod source for keybindings in the Claude Code bundle —
 * schemastore is the sole authoritative shape we have.
 */
export const keybindingsJsonLinter: Linter = {
	artifactType: "keybindings-json",

	lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
		const diagnostics: LintDiagnostic[] = [];
		const push = (d: LintDiagnostic | null) => {
			if (d) diagnostics.push(d);
		};

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (e) {
			push(diag(config, filePath, "keybindings-json/valid-json", "error",
				`Invalid JSON: ${(e as Error).message}`));
			return diagnostics;
		}

		if (isRuleEnabled(config, "keybindings-json/schema-valid")) {
			const compiled = loadKeybindingsSchema();
			if (compiled) {
				const ok = compiled.validate(parsed);
				if (!ok && compiled.validate.errors) {
					for (const err of summarizeErrors(compiled.validate.errors)) {
						push(diag(config, filePath, "keybindings-json/schema-valid", "error",
							formatAjvError(err)));
					}
				}
			}
		}

		return diagnostics;
	},
};

function diag(
	config: LinterConfig,
	filePath: string,
	ruleId: string,
	defaultSeverity: Severity,
	message: string,
): LintDiagnostic | null {
	if (!isRuleEnabled(config, ruleId)) return null;
	return {
		rule: ruleId,
		severity: getRuleSeverity(config, ruleId, defaultSeverity),
		message,
		file: filePath,
	};
}
