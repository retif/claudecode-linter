import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { isKebabCase } from "../utils/kebab-case.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "skill-md/valid-frontmatter", defaultSeverity: "error" },
  { id: "skill-md/name-required", defaultSeverity: "error" },
  { id: "skill-md/name-kebab-case", defaultSeverity: "error" },
  { id: "skill-md/name-max-length", defaultSeverity: "error" },
  { id: "skill-md/description-required", defaultSeverity: "error" },
  { id: "skill-md/description-max-length", defaultSeverity: "error" },
  { id: "skill-md/description-no-angle-brackets", defaultSeverity: "error" },
  { id: "skill-md/description-trigger-phrases", defaultSeverity: "warning" },
  { id: "skill-md/no-unknown-frontmatter", defaultSeverity: "warning" },
  { id: "skill-md/body-word-count", defaultSeverity: "warning" },
  { id: "skill-md/body-has-headers", defaultSeverity: "info" },
];

const KNOWN_FRONTMATTER = new Set([
  "name", "description", "version", "license",
  "allowed-tools", "metadata", "compatibility",
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

export const skillMdLinter: Linter = {
  artifactType: "skill-md",

  lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };

    const fm = parseFrontmatter(content);

    if (!fm.valid) {
      push(diag(config, filePath, "skill-md/valid-frontmatter", "error",
        fm.error ?? "Invalid frontmatter"));
      return diagnostics;
    }

    // name
    if (!("name" in fm.data) || typeof fm.data.name !== "string") {
      push(diag(config, filePath, "skill-md/name-required", "error",
        "\"name\" is required in frontmatter"));
    } else {
      const name = fm.data.name;
      if (!isKebabCase(name)) {
        push(diag(config, filePath, "skill-md/name-kebab-case", "error",
          `"name" must be kebab-case (got "${name}")`));
      }
      if (name.length > 64) {
        push(diag(config, filePath, "skill-md/name-max-length", "error",
          `"name" must be at most 64 characters (got ${name.length})`));
      }
    }

    // description
    if (!("description" in fm.data) || typeof fm.data.description !== "string") {
      push(diag(config, filePath, "skill-md/description-required", "error",
        "\"description\" is required in frontmatter"));
    } else {
      const desc = fm.data.description;
      if (desc.length > 1024) {
        push(diag(config, filePath, "skill-md/description-max-length", "error",
          `"description" must be at most 1024 characters (got ${desc.length})`));
      }
      if (/<|>/.test(desc)) {
        push(diag(config, filePath, "skill-md/description-no-angle-brackets", "error",
          "\"description\" must not contain angle brackets (< or >)"));
      }
      if (!/when the user|should be used when/i.test(desc)) {
        push(diag(config, filePath, "skill-md/description-trigger-phrases", "warning",
          "Description should contain trigger phrases (e.g., \"when the user asks to...\")"));
      }
    }

    // unknown frontmatter keys
    for (const key of Object.keys(fm.data)) {
      if (!KNOWN_FRONTMATTER.has(key)) {
        push(diag(config, filePath, "skill-md/no-unknown-frontmatter", "warning",
          `Unknown frontmatter key "${key}" (known: ${[...KNOWN_FRONTMATTER].join(", ")})`));
      }
    }

    // body checks
    const body = fm.body.trim();
    if (body) {
      const words = body.split(/\s+/).length;
      if (words < 500) {
        push(diag(config, filePath, "skill-md/body-word-count", "warning",
          `Body has ${words} words (recommended: 500-5000)`, fm.bodyStartLine));
      } else if (words > 5000) {
        push(diag(config, filePath, "skill-md/body-word-count", "warning",
          `Body has ${words} words — consider moving detail to references/ (recommended: 500-5000)`, fm.bodyStartLine));
      }

      if (!/^##\s/m.test(body)) {
        push(diag(config, filePath, "skill-md/body-has-headers", "info",
          "Body should use H2 (##) sections for organization", fm.bodyStartLine));
      }
    }

    return diagnostics;
  },
};

export { RULES as SKILL_MD_RULES };
