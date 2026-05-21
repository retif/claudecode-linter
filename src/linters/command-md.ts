import { TOOLS } from "../contracts.js";
import {
  formatAjvError,
  loadCommandFrontmatterSchema,
  summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import {
  artifactLabel,
  classifyUnknownFrontmatterKey,
} from "../utils/frontmatter-keys.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "command-md/valid-frontmatter", defaultSeverity: "error" },
  { id: "command-md/schema-valid", defaultSeverity: "error" },
  { id: "command-md/description-required", defaultSeverity: "error" },
  { id: "command-md/allowed-tools-valid", defaultSeverity: "warning" },
  { id: "command-md/body-present", defaultSeverity: "warning" },
  { id: "command-md/no-unknown-frontmatter", defaultSeverity: "info" },
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

export const commandMdLinter: Linter = {
  artifactType: "command-md",

  lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };

    const fm = parseFrontmatter(content);

    if (!fm.valid) {
      push(diag(config, filePath, "command-md/valid-frontmatter", "error",
        fm.error ?? "Invalid frontmatter"));
      return diagnostics;
    }

    // schema-valid — structural validation against the JSON Schema
    // auto-extracted from Claude Code's command frontmatter Zod validator.
    // The hand-written rules below add Claude-Code-specific advice (known
    // tool names, body presence). The extracted schema is intentionally
    // permissive about unknown frontmatter keys (Claude Code still loads the
    // command), so those are NOT reported here — command-md/no-unknown-
    // frontmatter handles them. Skipped silently if the schema bundle isn't
    // shipped with this install.
    if (isRuleEnabled(config, "command-md/schema-valid")) {
      const compiled = loadCommandFrontmatterSchema();
      if (compiled) {
        const ok = compiled.validate(fm.data);
        if (!ok && compiled.validate.errors) {
          for (const err of summarizeErrors(compiled.validate.errors)) {
            push(diag(config, filePath, "command-md/schema-valid", "error",
              formatAjvError(err)));
          }
        }
      }
    }

    // description
    if (!("description" in fm.data) || typeof fm.data.description !== "string") {
      push(diag(config, filePath, "command-md/description-required", "error",
        "\"description\" is required in frontmatter"));
    }

    // allowed-tools
    if ("allowed-tools" in fm.data) {
      const tools = fm.data["allowed-tools"];
      if (Array.isArray(tools)) {
        for (const t of tools) {
          if (typeof t === "string" && !TOOLS.has(t)) {
            push(diag(config, filePath, "command-md/allowed-tools-valid", "warning",
              `Unknown tool "${t}" in allowed-tools`));
          }
        }
      }
    }

    // Frontmatter keys: only flag cross-artifact misplacement. A key valid
    // for a *different* markdown artifact gets an info; a key valid for no
    // artifact stays silent. The hyphenated "allowed-tools"/"argument-hint"
    // are command-valid aliases of the camelCase contract keys.
    const extraKnown = new Set(["allowed-tools", "argument-hint"]);
    for (const key of Object.keys(fm.data)) {
      const cls = classifyUnknownFrontmatterKey(key, "command", extraKnown);
      if (cls?.kind === "owned-by-other" && cls.owner) {
        push(diag(config, filePath, "command-md/no-unknown-frontmatter", "info",
          `"${key}" is ${artifactLabel(cls.owner)} frontmatter — Claude Code ignores it on a command`));
      }
    }

    // body
    const body = fm.body.trim();
    if (!body) {
      push(diag(config, filePath, "command-md/body-present", "warning",
        "Command should have a body with instructions"));
    }

    return diagnostics;
  },
};

export { RULES as COMMAND_MD_RULES };
