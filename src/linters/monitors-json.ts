/**
 * Lints standalone `monitors/monitors.json` files (an array of monitor
 * entries). Validates against the schema auto-extracted from Claude Code's
 * runtime parser `vC8().parse(content)` — see scripts/extract-plugin-schema.ts
 * → buildMonitorsSchema().
 *
 * monitors-json/unique-names mirrors Claude Code's refine() check that
 * `Monitor names must be unique within a plugin`. JSON Schema can't express
 * that constraint natively so we enforce it here.
 */

import {
	formatAjvError,
	loadMonitorsSchema,
	summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef {
	id: string;
	defaultSeverity: Severity;
}

const RULES: RuleDef[] = [
	{ id: "monitors-json/valid-json", defaultSeverity: "error" },
	{ id: "monitors-json/schema-valid", defaultSeverity: "error" },
	{ id: "monitors-json/unique-names", defaultSeverity: "error" },
];

function diag(
	config: LinterConfig,
	filePath: string,
	ruleId: string,
	defaultSeverity: Severity,
	message: string,
	line?: number,
	column?: number,
): LintDiagnostic | null {
	if (!isRuleEnabled(config, ruleId)) return null;
	return {
		rule: ruleId,
		severity: getRuleSeverity(config, ruleId, defaultSeverity),
		message,
		file: filePath,
		line,
		column,
	};
}

export const monitorsJsonLinter: Linter = {
	artifactType: "monitors-json",

	lint(
		filePath: string,
		content: string,
		config: LinterConfig,
	): LintDiagnostic[] {
		const diagnostics: LintDiagnostic[] = [];
		const push = (d: LintDiagnostic | null) => {
			if (d) diagnostics.push(d);
		};

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (e) {
			push(
				diag(
					config,
					filePath,
					"monitors-json/valid-json",
					"error",
					`Invalid JSON: ${(e as Error).message}`,
				),
			);
			return diagnostics;
		}

		if (!Array.isArray(parsed)) {
			push(
				diag(
					config,
					filePath,
					"monitors-json/valid-json",
					"error",
					"monitors.json must be a JSON array of monitor entries",
				),
			);
			return diagnostics;
		}

		// Schema validation
		if (isRuleEnabled(config, "monitors-json/schema-valid")) {
			const ctx = loadMonitorsSchema();
			if (ctx) {
				const ok = ctx.validate(parsed);
				if (!ok && ctx.validate.errors) {
					const filtered = summarizeErrors(ctx.validate.errors);
					for (const err of filtered) {
						push(
							diag(
								config,
								filePath,
								"monitors-json/schema-valid",
								"error",
								formatAjvError(err),
							),
						);
					}
				}
			}
		}

		// Unique-name refinement — Claude Code's refine() check.
		if (isRuleEnabled(config, "monitors-json/unique-names")) {
			const seen = new Set<string>();
			const duplicates = new Set<string>();
			for (const entry of parsed) {
				if (
					entry &&
					typeof entry === "object" &&
					typeof (entry as Record<string, unknown>).name === "string"
				) {
					const name = (entry as Record<string, unknown>).name as string;
					if (seen.has(name)) duplicates.add(name);
					seen.add(name);
				}
			}
			for (const dup of duplicates) {
				push(
					diag(
						config,
						filePath,
						"monitors-json/unique-names",
						"error",
						`Monitor name "${dup}" is duplicated. Monitor names must be unique within a plugin.`,
					),
				);
			}
		}

		return diagnostics;
	},
};

export { RULES as MONITORS_JSON_RULES };
