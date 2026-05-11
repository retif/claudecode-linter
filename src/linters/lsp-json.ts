/**
 * Lints standalone `.lsp.json` files (a flat map of server-name → LSP server
 * config). Validates against the schema auto-extracted from Claude Code's
 * runtime parser `E.record(E.string(), RSH()).safeParse(content)` — see
 * scripts/extract-plugin-schema.ts → buildLspSchema().
 *
 * The most common mistake (observed in cluster plugin 0.29.0 → 0.30.3) is
 * wrapping the contents under a top-level `lspServers` key. That wrapper only
 * belongs inside plugin.json; a dedicated `.lsp.json` file must be flat.
 * lsp-json/no-lsp-servers-wrapper catches this with a friendlier message
 * than the generic "missing required field command" Ajv would otherwise emit.
 */

import {
	formatAjvError,
	loadLspSchema,
	summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef {
	id: string;
	defaultSeverity: Severity;
}

const RULES: RuleDef[] = [
	{ id: "lsp-json/valid-json", defaultSeverity: "error" },
	{ id: "lsp-json/no-lsp-servers-wrapper", defaultSeverity: "error" },
	{ id: "lsp-json/schema-valid", defaultSeverity: "error" },
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

function findKeyPosition(
	content: string,
	key: string,
): { line: number; column: number } | undefined {
	const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
	const match = re.exec(content);
	if (!match) return undefined;
	const before = content.slice(0, match.index);
	const line = before.split("\n").length;
	const lastNl = before.lastIndexOf("\n");
	const column = match.index - lastNl;
	return { line, column };
}

export const lspJsonLinter: Linter = {
	artifactType: "lsp-json",

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
					"lsp-json/valid-json",
					"error",
					`Invalid JSON: ${(e as Error).message}`,
				),
			);
			return diagnostics;
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			push(
				diag(
					config,
					filePath,
					"lsp-json/valid-json",
					"error",
					".lsp.json must be a JSON object (map of server-name → config)",
				),
			);
			return diagnostics;
		}

		const obj = parsed as Record<string, unknown>;

		// Special-case the cluster-plugin bug: wrapping content under "lspServers".
		// That key is only valid inline in plugin.json. The dedicated file uses a
		// flat map, so an "lspServers" wrapper is silently mis-validated by Claude
		// Code at session start (each server entry fails RSH validation since it
		// looks like one server config with sub-server keys).
		if ("lspServers" in obj) {
			const p = findKeyPosition(content, "lspServers");
			push(
				diag(
					config,
					filePath,
					"lsp-json/no-lsp-servers-wrapper",
					"error",
					'.lsp.json must not have a top-level "lspServers" key — the file is itself the map of server-name → config. The "lspServers" wrapper only belongs in plugin.json under the lspServers field.',
					p?.line,
					p?.column,
				),
			);
		}

		// Schema validation — defers to the extracted Zod-equivalent JSON Schema.
		if (isRuleEnabled(config, "lsp-json/schema-valid")) {
			const ctx = loadLspSchema();
			if (ctx) {
				const ok = ctx.validate(parsed);
				if (!ok && ctx.validate.errors) {
					const filtered = summarizeErrors(ctx.validate.errors);
					for (const err of filtered) {
						const firstSeg = err.instancePath
							.split("/")
							.filter(Boolean)[0];
						const p = firstSeg ? findKeyPosition(content, firstSeg) : undefined;
						push(
							diag(
								config,
								filePath,
								"lsp-json/schema-valid",
								"error",
								formatAjvError(err),
								p?.line,
								p?.column,
							),
						);
					}
				}
			}
		}

		return diagnostics;
	},
};

export { RULES as LSP_JSON_RULES };
