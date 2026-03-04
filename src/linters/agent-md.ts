import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "agent-md/valid-frontmatter", defaultSeverity: "error" },
  { id: "agent-md/name-required", defaultSeverity: "error" },
  { id: "agent-md/name-format", defaultSeverity: "error" },
  { id: "agent-md/description-required", defaultSeverity: "error" },
  { id: "agent-md/description-examples", defaultSeverity: "warning" },
  { id: "agent-md/model-required", defaultSeverity: "error" },
  { id: "agent-md/model-valid", defaultSeverity: "warning" },
  { id: "agent-md/color-required", defaultSeverity: "error" },
  { id: "agent-md/color-valid", defaultSeverity: "warning" },
  { id: "agent-md/system-prompt-present", defaultSeverity: "error" },
  { id: "agent-md/system-prompt-length", defaultSeverity: "warning" },
  { id: "agent-md/system-prompt-second-person", defaultSeverity: "info" },
];

const VALID_MODELS = new Set(["inherit", "sonnet", "opus", "haiku"]);
const VALID_COLORS = new Set(["blue", "cyan", "green", "yellow", "magenta", "red"]);

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

export const agentMdLinter: Linter = {
  artifactType: "agent-md",

  lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };

    const fm = parseFrontmatter(content);

    if (!fm.valid) {
      push(diag(config, filePath, "agent-md/valid-frontmatter", "error",
        fm.error ?? "Invalid frontmatter"));
      return diagnostics;
    }

    // name
    if (!("name" in fm.data) || typeof fm.data.name !== "string") {
      push(diag(config, filePath, "agent-md/name-required", "error",
        "\"name\" is required in frontmatter"));
    } else {
      const name = fm.data.name;
      if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) || name.length < 3 || name.length > 50) {
        push(diag(config, filePath, "agent-md/name-format", "error",
          `"name" must be 3-50 chars, lowercase alphanumeric + hyphens (got "${name}")`));
      }
    }

    // description
    if (!("description" in fm.data) || typeof fm.data.description !== "string") {
      push(diag(config, filePath, "agent-md/description-required", "error",
        "\"description\" is required in frontmatter"));
    } else {
      if (!/<example>/i.test(fm.data.description)) {
        push(diag(config, filePath, "agent-md/description-examples", "warning",
          "Description should include <example> blocks for triggering"));
      }
    }

    // model
    if (!("model" in fm.data) || typeof fm.data.model !== "string") {
      push(diag(config, filePath, "agent-md/model-required", "error",
        "\"model\" is required in frontmatter"));
    } else if (!VALID_MODELS.has(fm.data.model)) {
      push(diag(config, filePath, "agent-md/model-valid", "warning",
        `"model" must be one of: ${[...VALID_MODELS].join(", ")} (got "${fm.data.model}")`));
    }

    // color
    if (!("color" in fm.data) || typeof fm.data.color !== "string") {
      push(diag(config, filePath, "agent-md/color-required", "error",
        "\"color\" is required in frontmatter"));
    } else if (!VALID_COLORS.has(fm.data.color)) {
      push(diag(config, filePath, "agent-md/color-valid", "warning",
        `"color" must be one of: ${[...VALID_COLORS].join(", ")} (got "${fm.data.color}")`));
    }

    // system prompt (body)
    const body = fm.body.trim();
    if (!body) {
      push(diag(config, filePath, "agent-md/system-prompt-present", "error",
        "Agent must have a system prompt (body after frontmatter)"));
    } else {
      if (body.length < 20) {
        push(diag(config, filePath, "agent-md/system-prompt-length", "warning",
          `System prompt is very short (${body.length} chars, recommended >= 20)`,
          fm.bodyStartLine));
      }
      if (!/\byou\b/i.test(body)) {
        push(diag(config, filePath, "agent-md/system-prompt-second-person", "info",
          "System prompt should use second person (\"You are...\", \"You will...\")",
          fm.bodyStartLine));
      }
    }

    return diagnostics;
  },
};

export { RULES as AGENT_MD_RULES };
