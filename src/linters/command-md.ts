import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "command-md/valid-frontmatter", defaultSeverity: "error" },
  { id: "command-md/description-required", defaultSeverity: "error" },
  { id: "command-md/allowed-tools-valid", defaultSeverity: "warning" },
  { id: "command-md/body-present", defaultSeverity: "warning" },
];

const KNOWN_TOOLS = new Set([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebFetch", "WebSearch", "Agent", "AskUserQuestion",
  "NotebookEdit", "TodoWrite", "EnterPlanMode", "ExitPlanMode",
]);

function diag(
  config: LinterConfig,
  filePath: string,
  ruleId: string,
  defaultSeverity: Severity,
  message: string,
  line?: number,
): LintDiagnostic | null {
  if (!isRuleEnabled(config, ruleId)) return null;
  return {
    rule: ruleId,
    severity: getRuleSeverity(config, ruleId, defaultSeverity),
    message,
    file: filePath,
    line,
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
          if (typeof t === "string" && !KNOWN_TOOLS.has(t)) {
            push(diag(config, filePath, "command-md/allowed-tools-valid", "warning",
              `Unknown tool "${t}" in allowed-tools`));
          }
        }
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
