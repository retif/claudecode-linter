import { basename } from "node:path";
import type { Linter, LintDiagnostic, LinterConfig, Severity, ConfigScope } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "settings-json/valid-json", defaultSeverity: "error" },
  { id: "settings-json/scope-file-name", defaultSeverity: "error" },
  { id: "settings-json/scope-field", defaultSeverity: "warning" },
  { id: "settings-json/no-unknown-fields", defaultSeverity: "warning" },
  { id: "settings-json/permissions-object", defaultSeverity: "error" },
  { id: "settings-json/allow-array", defaultSeverity: "error" },
  { id: "settings-json/allow-known-tools", defaultSeverity: "warning" },
  { id: "settings-json/deny-array", defaultSeverity: "error" },
  { id: "settings-json/env-object", defaultSeverity: "error" },
  { id: "settings-json/env-string-values", defaultSeverity: "warning" },
  { id: "settings-json/plugins-object", defaultSeverity: "error" },
  { id: "settings-json/plugins-boolean", defaultSeverity: "warning" },
  { id: "settings-json/plugins-format", defaultSeverity: "warning" },
  { id: "settings-json/skip-prompt-boolean", defaultSeverity: "error" },
];

// Fields valid at user level (settings.json)
const USER_FIELDS = new Set([
  "env", "permissions", "enabledPlugins",
  "skipDangerousModePermissionPrompt",
]);

// Fields valid at project/subdirectory level (settings.local.json)
const PROJECT_FIELDS = new Set([
  "permissions",
]);

const KNOWN_TOOLS = new Set([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebFetch", "WebSearch", "Agent", "AskUserQuestion",
  "NotebookEdit", "TodoWrite", "EnterPlanMode", "ExitPlanMode",
  "Skill", "EnterWorktree", "SendMessage", "TaskCreate",
  "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput",
  "TeamCreate", "TeamDelete", "NotebookRead",
]);

function diag(
  config: LinterConfig,
  filePath: string,
  ruleId: string,
  defaultSeverity: Severity,
  message: string,
): LintDiagnostic | null {
  if (!isRuleEnabled(config, ruleId)) return null;
  return {
    rule: ruleId,
    severity: getRuleSeverity(config, ruleId, defaultSeverity),
    message,
    file: filePath,
  };
}

export const settingsJsonLinter: Linter = {
  artifactType: "settings-json",

  lint(filePath: string, content: string, config: LinterConfig, scope?: ConfigScope): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };
    const fileName = basename(filePath);
    const isLocal = fileName === "settings.local.json";

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      push(diag(config, filePath, "settings-json/valid-json", "error",
        `Invalid JSON: ${(e as Error).message}`));
      return diagnostics;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      push(diag(config, filePath, "settings-json/valid-json", "error",
        "settings.json must be a JSON object"));
      return diagnostics;
    }

    // Scope-aware: settings.json (non-local) should only be at user level
    if (!isLocal && scope && scope !== "user") {
      push(diag(config, filePath, "settings-json/scope-file-name", "error",
        `"settings.json" should only exist at user level (~/.claude/). Use "settings.local.json" for project-level settings`));
    }

    // Determine which fields are valid for this scope
    const knownFields = (scope === "user" || !scope) ? USER_FIELDS : PROJECT_FIELDS;

    // unknown/misplaced top-level fields
    for (const key of Object.keys(parsed)) {
      if (!knownFields.has(key)) {
        if (USER_FIELDS.has(key) && scope && scope !== "user") {
          push(diag(config, filePath, "settings-json/scope-field", "warning",
            `"${key}" is a user-level field — it has no effect in project-level settings.local.json`));
        } else if (!USER_FIELDS.has(key)) {
          push(diag(config, filePath, "settings-json/no-unknown-fields", "warning",
            `Unknown top-level field "${key}"`));
        }
      }
    }

    // permissions
    if ("permissions" in parsed) {
      const perms = parsed.permissions;
      if (typeof perms !== "object" || perms === null || Array.isArray(perms)) {
        push(diag(config, filePath, "settings-json/permissions-object", "error",
          "\"permissions\" must be an object"));
      } else {
        const p = perms as Record<string, unknown>;

        // allow list
        if ("allow" in p) {
          if (!Array.isArray(p.allow)) {
            push(diag(config, filePath, "settings-json/allow-array", "error",
              "\"permissions.allow\" must be an array of strings"));
          } else {
            for (const entry of p.allow) {
              if (typeof entry !== "string") {
                push(diag(config, filePath, "settings-json/allow-array", "error",
                  `"permissions.allow" entries must be strings (got ${typeof entry})`));
                continue;
              }
              // Extract base tool name from scoped pattern like "Bash(cmd:*)"
              const toolMatch = entry.match(/^([A-Za-z]+)(\(.*\))?$/);
              if (toolMatch) {
                const toolName = toolMatch[1];
                if (!KNOWN_TOOLS.has(toolName)) {
                  // Allow MCP tool patterns (mcp__*)
                  if (!entry.startsWith("mcp__")) {
                    push(diag(config, filePath, "settings-json/allow-known-tools", "warning",
                      `Unknown tool "${toolName}" in permissions.allow`));
                  }
                }
              }
            }
          }
        }

        // deny list
        if ("deny" in p) {
          if (!Array.isArray(p.deny)) {
            push(diag(config, filePath, "settings-json/deny-array", "error",
              "\"permissions.deny\" must be an array of strings"));
          }
        }
      }
    }

    // env — user-level only
    if ("env" in parsed) {
      const env = parsed.env;
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        push(diag(config, filePath, "settings-json/env-object", "error",
          "\"env\" must be an object of string key-value pairs"));
      } else {
        for (const [key, val] of Object.entries(env as Record<string, unknown>)) {
          if (typeof val !== "string") {
            push(diag(config, filePath, "settings-json/env-string-values", "warning",
              `"env.${key}" should be a string (got ${typeof val})`));
          }
        }
      }
    }

    // enabledPlugins — user-level only
    if ("enabledPlugins" in parsed) {
      const plugins = parsed.enabledPlugins;
      if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
        push(diag(config, filePath, "settings-json/plugins-object", "error",
          "\"enabledPlugins\" must be an object"));
      } else {
        for (const [key, val] of Object.entries(plugins as Record<string, unknown>)) {
          if (typeof val !== "boolean") {
            push(diag(config, filePath, "settings-json/plugins-boolean", "warning",
              `"enabledPlugins.${key}" should be a boolean (got ${typeof val})`));
          }
          if (!key.includes("@")) {
            push(diag(config, filePath, "settings-json/plugins-format", "warning",
              `Plugin key "${key}" should be in "name@marketplace" format`));
          }
        }
      }
    }

    // skipDangerousModePermissionPrompt — user-level only
    if ("skipDangerousModePermissionPrompt" in parsed) {
      if (typeof parsed.skipDangerousModePermissionPrompt !== "boolean") {
        push(diag(config, filePath, "settings-json/skip-prompt-boolean", "error",
          "\"skipDangerousModePermissionPrompt\" must be a boolean"));
      }
    }

    return diagnostics;
  },
};

export { RULES as SETTINGS_JSON_RULES };
