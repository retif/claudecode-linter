import {
	formatAjvError,
	loadMarketplaceSchema,
	summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef {
	id: string;
	defaultSeverity: Severity;
}

export const MARKETPLACE_JSON_RULES: RuleDef[] = [
	{ id: "marketplace-json/valid-json", defaultSeverity: "error" },
	{ id: "marketplace-json/schema-valid", defaultSeverity: "error" },
];

/**
 * Validate `.claude-plugin/marketplace.json` against the schemastore.org
 * curated schema. There's no Zod source for marketplace.json in the Claude
 * Code bundle — schemastore is the sole authoritative shape we have.
 *
 * If the schemastore bundle isn't shipped with this install (unlikely;
 * package.json includes it), the schema check silently skips.
 */
export const marketplaceJsonLinter: Linter = {
	artifactType: "marketplace-json",

	lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
		const diagnostics: LintDiagnostic[] = [];
		const push = (d: LintDiagnostic | null) => {
			if (d) diagnostics.push(d);
		};

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (e) {
			push(diag(config, filePath, "marketplace-json/valid-json", "error",
				`Invalid JSON: ${(e as Error).message}`));
			return diagnostics;
		}

		if (isRuleEnabled(config, "marketplace-json/schema-valid")) {
			const compiled = loadMarketplaceSchema();
			if (compiled) {
				const ok = compiled.validate(parsed);
				if (!ok && compiled.validate.errors) {
					for (const err of summarizeErrors(compiled.validate.errors)) {
						push(diag(config, filePath, "marketplace-json/schema-valid", "error",
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
