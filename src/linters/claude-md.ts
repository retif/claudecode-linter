import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { Linter, LintDiagnostic, LinterConfig, Severity, ConfigScope } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import {
  extractImports,
  findProjectRoot,
  isDir,
  isInside,
  resolveImport,
  type ImportRef,
} from "../utils/references.js";

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
  { id: "claude-md/import-resolves", defaultSeverity: "warning" },
  { id: "claude-md/import-circular", defaultSeverity: "info" },
  { id: "claude-md/import-depth", defaultSeverity: "warning" },
];

// Claude Code 2.1.301 `Tfr = 5`: the loader refuses a file at depth >= 5, so
// the root CLAUDE.md plus four nested hops load and a fifth is dropped.
const MAX_IMPORT_DEPTH = 5;

/**
 * Follow `@path` imports the way Claude Code's loader does — one global
 * visited set (a diamond loads once), cycles and over-deep hops silently
 * skipped at runtime — and report what the runtime would silently lose.
 * Only markdown files inside the project root are read; anything else is
 * existence-checked. Nested findings are reported at the root file's
 * top-level import that leads to them.
 */
function checkImports(
  filePath: string,
  content: string,
  config: LinterConfig,
  push: (d: LintDiagnostic | null) => void,
): void {
  if (!["claude-md/import-resolves", "claude-md/import-circular", "claude-md/import-depth"]
    .some((r) => isRuleEnabled(config, r))) return;
  const rootFile = resolve(filePath);
  const root = findProjectRoot(rootFile) ?? dirname(rootFile);
  const visited = new Set<string>([rootFile]);
  const stack: string[] = [];

  const walk = (file: string, text: string, depth: number, top: ImportRef | null, chain: string[]) => {
    stack.push(file);
    const where = chain.length > 0 ? ` (in ${relative(dirname(rootFile), file)}, via ${chain.join(" → ")})` : "";
    for (const imp of extractImports(text)) {
      if (imp.path.includes("$")) continue;
      const at = top ?? imp;
      const target = resolveImport(imp.path, file);
      if (!existsSync(target)) {
        // `@name` mentions and `@scope/pkg` names are also tried as paths
        // and silently miss; only flag what looks like a file reference.
        const bare = !/^(\.\/|~\/|\/)/.test(imp.path);
        const hasExt = /\.[^/.]+$/.test(basename(imp.path));
        if (bare && !hasExt && (!imp.path.includes("/") || !isDir(dirname(target)))) continue;
        push(diag(config, filePath, "claude-md/import-resolves", "warning",
          `Import "@${imp.path}"${where} does not resolve — ${target} does not exist`, at.line, at.column));
        continue;
      }
      if (isDir(target)) {
        push(diag(config, filePath, "claude-md/import-resolves", "warning",
          `Import "@${imp.path}"${where} is a directory — Claude Code only imports files`, at.line, at.column));
        continue;
      }
      if (stack.includes(target)) {
        push(diag(config, filePath, "claude-md/import-circular", "info",
          `Import "@${imp.path}"${where} is circular — it leads back to ${relative(dirname(rootFile), target) || basename(target)}, which Claude Code skips`,
          at.line, at.column));
        continue;
      }
      if (visited.has(target)) continue;
      // Depth is gated before the runtime marks a file processed, so a file
      // too deep on one path still loads if reached by a shorter one.
      if (depth + 1 >= MAX_IMPORT_DEPTH) {
        push(diag(config, filePath, "claude-md/import-depth", "warning",
          `Import "@${imp.path}"${where} is ${depth + 1} hops deep — Claude Code stops at ${MAX_IMPORT_DEPTH - 1} and silently drops it`,
          at.line, at.column));
        continue;
      }
      visited.add(target);
      if (!isInside(root, target) || !/\.(md|markdown)$/i.test(target)) continue;
      let next: string;
      try {
        next = readFileSync(target, "utf-8");
      } catch {
        continue;
      }
      walk(target, next, depth + 1, at, [...chain, `@${imp.path}`]);
    }
    stack.pop();
  };

  walk(rootFile, content, 0, null, []);
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
      // Project CLAUDE.md should describe the project. This is satisfied by
      // either an explicit overview-style heading OR descriptive prose near
      // the top — a CLAUDE.md that opens with a title followed by a sentence
      // of project description does not need a literal "Overview" heading.
      const hasOverviewHeading = lines.some((l) =>
        /^#+ .*(overview|project|about|description|what this is|introduction|summary)/i.test(l));
      // Descriptive opening prose: a non-heading, non-list, non-blank line
      // of reasonable length appearing before the first H2 section.
      const firstH2 = lines.findIndex((l) => /^## /.test(l));
      const preambleEnd = firstH2 >= 0 ? firstH2 : lines.length;
      const hasOpeningProse = lines.slice(0, preambleEnd).some((l) => {
        const t = l.trim();
        return t.length >= 25 && !t.startsWith("#") && !/^[-*>|]/.test(t);
      });
      const hasProjectOverview = hasOverviewHeading || hasOpeningProse;
      if (!hasProjectOverview && h2Count > 0) {
        push(diag(config, filePath, "claude-md/project-has-overview", "info",
          "Project CLAUDE.md should include a project overview — an \"Overview\" section or descriptive opening prose"));
      }
    }

    // detect potential secrets
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // API keys, tokens, passwords in plain text
      const secretMatch = /(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-/.]{20,}/i.exec(line);
      if (secretMatch) {
        push(diag(config, filePath, "claude-md/no-secrets", "error",
          "Possible secret or token detected — do not store credentials in CLAUDE.md",
          i + 1, secretMatch.index + 1));
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
            i + 1, match.index + 1));
        }
      }
    }

    checkImports(filePath, content, config, push);

    // check for TODO/FIXME markers left in instructions
    for (let i = 0; i < lines.length; i++) {
      const todoMatch = /\b(TODO|FIXME|HACK|XXX)\b/.exec(lines[i]);
      if (todoMatch) {
        push(diag(config, filePath, "claude-md/no-todo-markers", "info",
          `Found ${todoMatch[0]} marker — resolve before finalizing`,
          i + 1, todoMatch.index + 1));
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
