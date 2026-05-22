import { HOOK_EVENTS, HOOK_TYPES, PROMPT_EVENTS } from "../contracts.js";
import {
  formatAjvError,
  loadHooksJsonSchema,
  summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "hooks-json/valid-json", defaultSeverity: "error" },
  { id: "hooks-json/schema-valid", defaultSeverity: "error" },
  { id: "hooks-json/root-hooks-key", defaultSeverity: "error" },
  { id: "hooks-json/valid-event-names", defaultSeverity: "error" },
  { id: "hooks-json/hook-type-required", defaultSeverity: "error" },
  { id: "hooks-json/command-has-command", defaultSeverity: "error" },
  { id: "hooks-json/no-hardcoded-paths", defaultSeverity: "warning" },
  { id: "hooks-json/prompt-has-prompt", defaultSeverity: "error" },
  { id: "hooks-json/prompt-event-support", defaultSeverity: "warning" },
  { id: "hooks-json/timeout-range", defaultSeverity: "warning" },
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

export const hooksJsonLinter: Linter = {
  artifactType: "hooks-json",

  lint(filePath: string, content: string, config: LinterConfig): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      push(diag(config, filePath, "hooks-json/valid-json", "error",
        `Invalid JSON: ${(e as Error).message}`));
      return diagnostics;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      push(diag(config, filePath, "hooks-json/valid-json", "error",
        "hooks.json must be a JSON object"));
      return diagnostics;
    }

    // schema-valid — structural validation against the JSON Schema
    // auto-extracted from Claude Code's hooks-config Zod validator (the
    // hook-event → matcher-array map, each matcher holding a discriminated
    // union of hook definitions). The hand-written rules below add
    // Claude-Code-specific advice the schema can't express (hardcoded-path
    // warnings, prompt-event-support hints, …). The extracted schema is
    // intentionally permissive about unknown hook fields (Claude Code's hook
    // objects are not .strict()). Skipped silently if the schema bundle isn't
    // shipped with this install.
    if (isRuleEnabled(config, "hooks-json/schema-valid")) {
      const compiled = loadHooksJsonSchema();
      if (compiled) {
        const ok = compiled.validate(parsed);
        if (!ok && compiled.validate.errors) {
          for (const err of summarizeErrors(compiled.validate.errors)) {
            const firstSeg = err.instancePath.split("/").filter(Boolean)[0];
            const p = firstSeg ? findKeyPosition(content, firstSeg) : undefined;
            push(diag(config, filePath, "hooks-json/schema-valid", "error",
              formatAjvError(err), p?.line, p?.column));
          }
        }
      }
    }

    const root = parsed as Record<string, unknown>;

    // root "hooks" key
    if (!("hooks" in root) || typeof root.hooks !== "object" || root.hooks === null) {
      push(diag(config, filePath, "hooks-json/root-hooks-key", "error",
        "Root must have a \"hooks\" key containing event definitions"));
      return diagnostics;
    }

    const hooks = root.hooks as Record<string, unknown>;

    for (const [eventName, matchers] of Object.entries(hooks)) {
      const ep = findKeyPosition(content, eventName);
      // valid event name
      if (!HOOK_EVENTS.has(eventName)) {
        push(diag(config, filePath, "hooks-json/valid-event-names", "error",
          `Invalid event name "${eventName}" (valid: ${[...HOOK_EVENTS].join(", ")})`, ep?.line, ep?.column));
        continue;
      }

      if (!Array.isArray(matchers)) continue;

      for (const matcher of matchers) {
        if (typeof matcher !== "object" || matcher === null) continue;
        const m = matcher as Record<string, unknown>;
        const hookList = m.hooks;
        if (!Array.isArray(hookList)) continue;

        for (const hook of hookList) {
          if (typeof hook !== "object" || hook === null) continue;
          const h = hook as Record<string, unknown>;

          // type required
          if (!("type" in h) || typeof h.type !== "string" || !HOOK_TYPES.has(h.type)) {
            const valid = [...HOOK_TYPES].join(", ");
            push(diag(config, filePath, "hooks-json/hook-type-required", "error",
              `Hook in ${eventName} must have "type" set to one of: ${valid}`, ep?.line, ep?.column));
            continue;
          }

          if (h.type === "command") {
            if (!("command" in h) || typeof h.command !== "string") {
              push(diag(config, filePath, "hooks-json/command-has-command", "error",
                `Command hook in ${eventName} must have a "command" field`, ep?.line, ep?.column));
            } else if (/^\//.test(h.command) && !h.command.includes("${CLAUDE_PLUGIN_ROOT}")) {
              push(diag(config, filePath, "hooks-json/no-hardcoded-paths", "warning",
                `Hook command uses absolute path — use \${CLAUDE_PLUGIN_ROOT} instead`, ep?.line, ep?.column));
            }
          }

          if (h.type === "prompt") {
            if (!("prompt" in h) || typeof h.prompt !== "string") {
              push(diag(config, filePath, "hooks-json/prompt-has-prompt", "error",
                `Prompt hook in ${eventName} must have a "prompt" field`, ep?.line, ep?.column));
            }
            if (!PROMPT_EVENTS.has(eventName)) {
              push(diag(config, filePath, "hooks-json/prompt-event-support", "warning",
                `Prompt hooks work best on ${[...PROMPT_EVENTS].join(", ")} (used on ${eventName})`, ep?.line, ep?.column));
            }
          }

          // timeout
          if ("timeout" in h && typeof h.timeout === "number") {
            if (h.timeout < 5 || h.timeout > 600) {
              push(diag(config, filePath, "hooks-json/timeout-range", "warning",
                `Hook timeout ${h.timeout}s is outside recommended range (5-600s)`, ep?.line, ep?.column));
            }
          }
        }
      }
    }

    return diagnostics;
  },
};

export { RULES as HOOKS_JSON_RULES };
