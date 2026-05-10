export type Severity = "error" | "warning" | "info";

export type ArtifactType =
  | "plugin-json"
  | "skill-md"
  | "agent-md"
  | "command-md"
  | "hooks-json"
  | "settings-json"
  | "mcp-json"
  | "claude-md"
  | "misplaced-file";

export interface LintDiagnostic {
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  line?: number;
  column?: number;
}

export interface LintResult {
  file: string;
  artifact: ArtifactType;
  diagnostics: LintDiagnostic[];
  fixed?: number;
}

export interface RuleConfig {
  enabled: boolean;
  severity?: Severity;
}

export interface LinterConfig {
  rules: Record<string, RuleConfig | boolean>;
}

export interface Linter {
  artifactType: ArtifactType;
  lint(filePath: string, content: string, config: LinterConfig, scope?: ConfigScope): LintDiagnostic[];
}

export interface Fixer {
  artifactType: ArtifactType;
  fix(filePath: string, content: string, config: LinterConfig): Promise<string>;
}

export type ConfigScope = "user" | "project" | "subdirectory";

export interface DiscoveredArtifact {
  filePath: string;
  artifactType: ArtifactType;
  scope?: ConfigScope;
}

export function isRuleEnabled(
  config: LinterConfig,
  ruleId: string,
): boolean {
  const rule = config.rules[ruleId];
  if (rule === undefined) return true;
  if (typeof rule === "boolean") return rule;
  return rule.enabled;
}

export function getRuleSeverity(
  config: LinterConfig,
  ruleId: string,
  defaultSeverity: Severity,
): Severity {
  const rule = config.rules[ruleId];
  if (rule === undefined || typeof rule === "boolean") return defaultSeverity;
  return rule.severity ?? defaultSeverity;
}
