import type { Linter, LintDiagnostic, LinterConfig, Severity, ConfigScope } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "claude-md/not-empty", defaultSeverity: "warning" },
  { id: "claude-md/starts-with-heading", defaultSeverity: "info" },
  { id: "claude-md/has-sections", defaultSeverity: "warning" },
  { id: "claude-md/user-level-concise", defaultSeverity: "info" },
  { id: "claude-md/project-has-overview", defaultSeverity: "info" },
  { id: "claude-md/no-secrets", defaultSeverity: "error" },
  { id: "claude-md/file-length", defaultSeverity: "warning" },
  { id: "claude-md/no-absolute-paths", defaultSeverity: "info" },
  { id: "claude-md/no-todo-markers", defaultSeverity: "info" },
  { id: "claude-md/no-trailing-whitespace", defaultSeverity: "info" },
];

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

export const claudeMdLinter: Linter = {
  artifactType: "claude-md",

  lint(filePath: string, content: string, config: LinterConfig, scope?: ConfigScope): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };
    const lines = content.split("\n");

    // empty file
    if (!content.trim()) {
      push(diag(config, filePath, "claude-md/not-empty", "warning",
        "CLAUDE.md is empty"));
      return diagnostics;
    }

    // should start with a heading
    const firstNonEmpty = lines.findIndex((l) => l.trim() !== "");
    if (firstNonEmpty >= 0 && !lines[firstNonEmpty].startsWith("#")) {
      push(diag(config, filePath, "claude-md/starts-with-heading", "info",
        "CLAUDE.md should start with a heading", firstNonEmpty + 1));
    }

    // check for H2 sections (structure)
    const h2Count = lines.filter((l) => /^## /.test(l)).length;
    if (h2Count === 0) {
      push(diag(config, filePath, "claude-md/has-sections", "warning",
        "CLAUDE.md should have H2 (##) sections for organization"));
    }

    // Scope-aware: user-level should be concise global rules, project-level should describe the project
    if (scope === "user" && lines.length > 100) {
      push(diag(config, filePath, "claude-md/user-level-concise", "info",
        `User-level CLAUDE.md is ${lines.length} lines — keep global rules concise, put project-specific content in project CLAUDE.md files`));
    }
    if (scope === "project") {
      // Project CLAUDE.md should have a project description
      const hasProjectOverview = lines.some((l) => /^#+ .*(overview|project|about|description)/i.test(l));
      if (!hasProjectOverview && h2Count > 0) {
        push(diag(config, filePath, "claude-md/project-has-overview", "info",
          "Project CLAUDE.md should include a project overview section"));
      }
    }

    // detect potential secrets
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // API keys, tokens, passwords in plain text
      if (/(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-/.]{20,}/i.test(line)) {
        push(diag(config, filePath, "claude-md/no-secrets", "error",
          "Possible secret or token detected — do not store credentials in CLAUDE.md",
          i + 1));
      }
    }

    // large file warning
    if (lines.length > 500) {
      push(diag(config, filePath, "claude-md/file-length", "warning",
        `CLAUDE.md is ${lines.length} lines — consider splitting into focused sections or separate files`));
    }

    // check for broken markdown links to local files
    const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
    for (let i = 0; i < lines.length; i++) {
      let match;
      while ((match = linkRe.exec(lines[i])) !== null) {
        const target = match[2];
        // skip URLs and anchors
        if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
          continue;
        }
        // warn about absolute paths
        if (target.startsWith("/")) {
          push(diag(config, filePath, "claude-md/no-absolute-paths", "info",
            `Link uses absolute path "${target}" — prefer relative paths`,
            i + 1));
        }
      }
    }

    // check for TODO/FIXME markers left in instructions
    for (let i = 0; i < lines.length; i++) {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(lines[i])) {
        push(diag(config, filePath, "claude-md/no-todo-markers", "info",
          `Found ${lines[i].match(/\b(TODO|FIXME|HACK|XXX)\b/)![0]} marker — resolve before finalizing`,
          i + 1));
      }
    }

    // trailing whitespace (formatting)
    let trailingCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/[ \t]+$/.test(lines[i])) {
        trailingCount++;
      }
    }
    if (trailingCount > 0) {
      push(diag(config, filePath, "claude-md/no-trailing-whitespace", "info",
        `${trailingCount} line${trailingCount !== 1 ? "s" : ""} with trailing whitespace`));
    }

    return diagnostics;
  },
};

export { RULES as CLAUDE_MD_RULES };
