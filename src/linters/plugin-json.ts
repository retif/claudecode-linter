import { PLUGIN_JSON_FIELDS } from "../contracts.js";
import {
	formatAjvError,
	loadPluginSchema,
	summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { isKebabCase } from "../utils/kebab-case.js";
import { isValidSemver } from "../utils/semver.js";

const SPDX_COMMON = new Set([
  "MIT", "Apache-2.0", "GPL-2.0-only", "GPL-3.0-only",
  "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0",
  "LGPL-2.1-only", "LGPL-3.0-only", "UNLICENSED",
]);

interface RuleDef {
  id: string;
  defaultSeverity: Severity;
}

const RULES: RuleDef[] = [
  { id: "plugin-json/valid-json", defaultSeverity: "error" },
  { id: "plugin-json/schema-valid", defaultSeverity: "error" },
  { id: "plugin-json/name-required", defaultSeverity: "error" },
  { id: "plugin-json/name-kebab-case", defaultSeverity: "error" },
  { id: "plugin-json/name-length", defaultSeverity: "error" },
  { id: "plugin-json/description-required", defaultSeverity: "warning" },
  { id: "plugin-json/version-semver", defaultSeverity: "warning" },
  { id: "plugin-json/author-object", defaultSeverity: "info" },
  { id: "plugin-json/repository-url", defaultSeverity: "warning" },
  { id: "plugin-json/keywords-array", defaultSeverity: "warning" },
  { id: "plugin-json/keywords-no-duplicates", defaultSeverity: "warning" },
  { id: "plugin-json/no-unknown-fields", defaultSeverity: "info" },
  { id: "plugin-json/license-spdx", defaultSeverity: "info" },
  { id: "plugin-json/no-inline-mcp-servers", defaultSeverity: "warning" },
];

function findKeyPosition(content: string, key: string): { line: number; column: number } | undefined {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
  const match = re.exec(content);
  if (!match) return undefined;
  const before = content.slice(0, match.index);
  const line = before.split("\n").length;
  const lastNl = before.lastIndexOf("\n");
  const column = match.index - lastNl;
  return { line, column };
}

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

export const pluginJsonLinter: Linter = {
  artifactType: "plugin-json",

  lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };
    const pos = (key: string) => findKeyPosition(content, key);

    // Parse JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      push(diag(config, filePath, "plugin-json/valid-json", "error",
        `Invalid JSON: ${(e as Error).message}`));
      return diagnostics;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      push(diag(config, filePath, "plugin-json/valid-json", "error",
        "plugin.json must be a JSON object"));
      return diagnostics;
    }

    // schema-valid — defer to extracted JSON Schema for type/enum/nested checks
    // that the per-field rules below don't cover. Existing rules (name-required,
    // version-semver, …) handle the common cases with friendlier messages, so
    // most users will see schema-valid fire only on deeper structural issues
    // (MCP transport unions, userConfig shape, etc.). Skipped silently if the
    // schema bundle isn't shipped with this install.
    if (isRuleEnabled(config, "plugin-json/schema-valid")) {
      const ctx = loadPluginSchema();
      if (ctx) {
        const ok = ctx.validate(parsed);
        if (!ok && ctx.validate.errors) {
          const filtered = summarizeErrors(ctx.validate.errors);
          for (const err of filtered) {
            // First path segment maps to a top-level field we can highlight.
            const firstSeg = err.instancePath.split("/").filter(Boolean)[0];
            const p = firstSeg ? pos(firstSeg) : undefined;
            push(diag(config, filePath, "plugin-json/schema-valid", "error",
              formatAjvError(err), p?.line, p?.column));
          }
        }
      }
    }

    // name
    if (!("name" in parsed) || typeof parsed.name !== "string" || parsed.name === "") {
      push(diag(config, filePath, "plugin-json/name-required", "error",
        "\"name\" field is required and must be a non-empty string"));
    } else {
      const name = parsed.name as string;
      const p = pos("name");
      if (!isKebabCase(name)) {
        push(diag(config, filePath, "plugin-json/name-kebab-case", "error",
          `"name" must be kebab-case (got "${name}")`, p?.line, p?.column));
      }
      if (name.length > 64) {
        push(diag(config, filePath, "plugin-json/name-length", "error",
          `"name" must be at most 64 characters (got ${name.length})`, p?.line, p?.column));
      }
    }

    // description
    if (!("description" in parsed) || typeof parsed.description !== "string") {
      push(diag(config, filePath, "plugin-json/description-required", "warning",
        "\"description\" field is recommended"));
    }

    // version
    if ("version" in parsed) {
      if (typeof parsed.version !== "string" || !isValidSemver(parsed.version)) {
        const p = pos("version");
        push(diag(config, filePath, "plugin-json/version-semver", "warning",
          `"version" should be valid semver (got "${parsed.version}")`, p?.line, p?.column));
      }
    }

    // author
    if ("author" in parsed) {
      const author = parsed.author;
      const p = pos("author");
      if (typeof author !== "object" || author === null || Array.isArray(author)) {
        push(diag(config, filePath, "plugin-json/author-object", "info",
          "\"author\" should be an object with \"name\" and optionally \"email\" fields", p?.line, p?.column));
      } else {
        const a = author as Record<string, unknown>;
        if (!("name" in a) || typeof a.name !== "string") {
          push(diag(config, filePath, "plugin-json/author-object", "info",
            "\"author.name\" should be a string", p?.line, p?.column));
        }
      }
    }

    // repository
    if ("repository" in parsed) {
      const p = pos("repository");
      if (typeof parsed.repository !== "string") {
        push(diag(config, filePath, "plugin-json/repository-url", "warning",
          "\"repository\" should be a URL string", p?.line, p?.column));
      } else {
        try {
          new URL(parsed.repository as string);
        } catch {
          push(diag(config, filePath, "plugin-json/repository-url", "warning",
            `"repository" is not a valid URL: "${parsed.repository}"`, p?.line, p?.column));
        }
      }
    }

    // keywords
    if ("keywords" in parsed) {
      const p = pos("keywords");
      if (!Array.isArray(parsed.keywords)) {
        push(diag(config, filePath, "plugin-json/keywords-array", "warning",
          "\"keywords\" must be an array", p?.line, p?.column));
      } else {
        const kw = parsed.keywords as unknown[];
        for (let i = 0; i < kw.length; i++) {
          if (typeof kw[i] !== "string") {
            push(diag(config, filePath, "plugin-json/keywords-array", "warning",
              `"keywords[${i}]" must be a string`, p?.line, p?.column));
          }
        }
        const seen = new Set<string>();
        for (const k of kw) {
          if (typeof k === "string") {
            if (seen.has(k)) {
              push(diag(config, filePath, "plugin-json/keywords-no-duplicates", "warning",
                `Duplicate keyword: "${k}"`, p?.line, p?.column));
            }
            seen.add(k);
          }
        }
      }
    }

    // unknown fields — prefer the schema's property set (full + nested-aware)
    // when available; fall back to the contract-extracted PLUGIN_JSON_FIELDS
    // for installs that didn't ship the schema bundle.
    {
      const ctx = loadPluginSchema();
      const known = ctx?.knownFields ?? PLUGIN_JSON_FIELDS;
      for (const key of Object.keys(parsed)) {
        if (!known.has(key)) {
          const p = pos(key);
          push(diag(config, filePath, "plugin-json/no-unknown-fields", "info",
            `Unknown field "${key}" (known: ${[...known].sort().join(", ")})`,
            p?.line, p?.column));
        }
      }
    }

    // gitea#9: mcpServers belongs in `.mcp.json` at the plugin root, not as
    // a top-level key in `.claude-plugin/plugin.json`. The legacy shape still
    // loads but uses a different code path and contradicts the official docs.
    if ("mcpServers" in parsed) {
      const p = pos("mcpServers");
      push(diag(config, filePath, "plugin-json/no-inline-mcp-servers", "warning",
        "\"mcpServers\" should not live inside plugin.json — move to .mcp.json at the plugin root. See https://code.claude.com/docs/en/plugins#plugin-structure-overview",
        p?.line, p?.column));
    }

    // license
    if ("license" in parsed && typeof parsed.license === "string") {
      if (!SPDX_COMMON.has(parsed.license as string)) {
        const p = pos("license");
        push(diag(config, filePath, "plugin-json/license-spdx", "info",
          `"license" "${parsed.license}" is not a common SPDX identifier`, p?.line, p?.column));
      }
    }

    return diagnostics;
  },
};

export { RULES as PLUGIN_JSON_RULES };
