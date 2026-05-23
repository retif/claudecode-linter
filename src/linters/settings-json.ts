import { basename } from "node:path";
import {
	SETTINGS_USER_FIELDS,
	SETTINGS_PROJECT_FIELDS,
	TOOLS,
	PERMISSIONS_FIELDS,
	PERMISSION_MODES,
	SANDBOX_FIELDS,
	SANDBOX_NETWORK_FIELDS,
	SANDBOX_FILESYSTEM_FIELDS,
} from "../contracts.js";
import {
	formatAjvError,
	loadSettingsSchema,
	summarizeErrors,
} from "../plugin-schema.js";
import type { Linter, LintDiagnostic, LinterConfig, Severity, ConfigScope } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "settings-json/valid-json", defaultSeverity: "error" },
  { id: "settings-json/schema-valid", defaultSeverity: "error" },
  // settings-json/scope-file-name removed in gitea#4 — .claude/settings.json
  // is a valid project-shared settings source. See misplaced-file/* for
  // wrong-path warnings.
  { id: "settings-json/scope-field", defaultSeverity: "warning" },
  { id: "settings-json/no-unknown-fields", defaultSeverity: "warning" },
  { id: "settings-json/permissions-object", defaultSeverity: "error" },
  { id: "settings-json/permissions-unknown-field", defaultSeverity: "warning" },
  { id: "settings-json/permissions-default-mode", defaultSeverity: "warning" },
  { id: "settings-json/permissions-disable-bypass", defaultSeverity: "warning" },
  { id: "settings-json/permissions-field-type", defaultSeverity: "warning" },
  { id: "settings-json/allow-array", defaultSeverity: "error" },
  { id: "settings-json/allow-known-tools", defaultSeverity: "warning" },
  { id: "settings-json/deny-array", defaultSeverity: "error" },
  { id: "settings-json/ask-array", defaultSeverity: "error" },
  { id: "settings-json/permission-rule-syntax", defaultSeverity: "error" },
  { id: "settings-json/permission-rule-pattern", defaultSeverity: "error" },
  { id: "settings-json/sandbox-object", defaultSeverity: "error" },
  { id: "settings-json/sandbox-unknown-field", defaultSeverity: "warning" },
  { id: "settings-json/sandbox-field-type", defaultSeverity: "warning" },
  { id: "settings-json/env-object", defaultSeverity: "error" },
  { id: "settings-json/env-string-values", defaultSeverity: "warning" },
  { id: "settings-json/plugins-object", defaultSeverity: "error" },
  { id: "settings-json/plugins-boolean", defaultSeverity: "warning" },
  { id: "settings-json/plugins-format", defaultSeverity: "warning" },
  { id: "settings-json/skip-prompt-boolean", defaultSeverity: "error" },
];

type FieldType = "boolean" | "string" | "number" | "string-array" | "object";

// Expected type for each known sandbox sub-key, and for the nested
// network/filesystem objects. Mirrors Claude Code's Zod schema.
const SANDBOX_FIELD_TYPES: Record<string, FieldType> = {
  enabled: "boolean",
  failIfUnavailable: "boolean",
  autoAllowBashIfSandboxed: "boolean",
  allowUnsandboxedCommands: "boolean",
  enableWeakerNestedSandbox: "boolean",
  enableWeakerNetworkIsolation: "boolean",
  excludedCommands: "string-array",
  network: "object",
  filesystem: "object",
  ripgrep: "object",
  ignoreViolations: "object",
  bwrapPath: "string",
};

const NETWORK_FIELD_TYPES: Record<string, FieldType> = {
  allowedDomains: "string-array",
  deniedDomains: "string-array",
  allowManagedDomainsOnly: "boolean",
  allowUnixSockets: "string-array",
  allowAllUnixSockets: "boolean",
  allowLocalBinding: "boolean",
  allowMachLookup: "string-array",
  httpProxyPort: "number",
  socksProxyPort: "number",
  tlsTerminate: "object",
};

const FILESYSTEM_FIELD_TYPES: Record<string, FieldType> = {
  allowWrite: "string-array",
  denyWrite: "string-array",
  denyRead: "string-array",
  allowRead: "string-array",
  allowManagedReadPathsOnly: "boolean",
};

// sandbox.network.tlsTerminate — a small nested object of optional paths.
const TLS_TERMINATE_FIELD_TYPES: Record<string, FieldType> = {
  caCertPath: "string",
  caKeyPath: "string",
};

// Tool classes that drive per-rule pattern validation (Claude Code's `Fx$`).
const FILE_PATTERN_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "NotebookRead", "NotebookEdit"]);
const BASH_PREFIX_TOOLS = new Set(["Bash"]);

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(expected: FieldType, val: unknown): boolean {
  switch (expected) {
    case "boolean": return typeof val === "boolean";
    case "string": return typeof val === "string";
    case "number": return typeof val === "number";
    case "string-array": return isStringArray(val);
    case "object": return isPlainObject(val);
  }
}

function articleType(expected: FieldType): string {
  switch (expected) {
    case "boolean": return "a boolean";
    case "string": return "a string";
    case "number": return "a number";
    case "string-array": return "an array of strings";
    case "object": return "an object";
  }
}

/**
 * Lightweight permission-rule syntax check, mirroring the syntactic rejections
 * of Claude Code's runtime rule validator (the per-tool pattern grammar is
 * deliberately not reproduced). Returns an error description, or null if the
 * rule is syntactically well-formed.
 */
function ruleSyntaxError(rule: string): string | null {
  if (rule.trim() === "") return "permission rule cannot be empty";

  const opens = (rule.match(/\(/g) ?? []).length;
  const closes = (rule.match(/\)/g) ?? []).length;
  if (opens !== closes) return "mismatched parentheses";

  if (/\(\s*\)/.test(rule)) {
    const before = rule.slice(0, rule.indexOf("(")).trim();
    return before === ""
      ? "empty parentheses with no tool name"
      : `empty parentheses — use "${before}" alone, or specify a pattern`;
  }

  const parenIdx = rule.indexOf("(");
  const toolName = (parenIdx === -1 ? rule : rule.slice(0, parenIdx)).trim();
  if (toolName === "") return "tool name cannot be empty";

  if (rule.startsWith("mcp__")) {
    return parenIdx === -1
      ? null
      : "MCP rules do not support patterns in parentheses";
  }

  if (!toolName.includes("_") && toolName[0] !== toolName[0].toUpperCase()) {
    return "tool names must start with an uppercase letter";
  }
  return null;
}

/**
 * Split a syntactically valid rule into its tool name and parenthesized
 * pattern. `content` is null for a bare tool or a `()` / `(*)` wildcard.
 */
function parseRule(rule: string): { toolName: string; content: string | null } {
  const open = rule.indexOf("(");
  if (open === -1) return { toolName: rule.trim(), content: null };
  const inner = rule.slice(open + 1, rule.lastIndexOf(")"));
  return {
    toolName: rule.slice(0, open).trim(),
    content: inner === "" || inner === "*" ? null : inner,
  };
}

/**
 * Per-tool pattern validation, mirroring Claude Code's `Fx$` rule table:
 * WebSearch/WebFetch custom validators, the Bash `:*` prefix marker, and the
 * file-pattern tools that reject `:*`. Returns an error description or null.
 */
function ruleContentError(toolName: string, content: string): string | null {
  if (toolName === "WebSearch") {
    if (content.includes("*") || content.includes("?")) {
      return "WebSearch rules do not support wildcards (* or ?)";
    }
  } else if (toolName === "WebFetch") {
    if (content.includes("://") || content.startsWith("http")) {
      return "WebFetch rules use \"domain:hostname\" format, not URLs";
    }
    if (!content.startsWith("domain:")) {
      return "WebFetch rules must use the \"domain:\" prefix";
    }
  } else if (BASH_PREFIX_TOOLS.has(toolName)) {
    if (content.includes(":*") && !content.endsWith(":*")) {
      return "the \":*\" prefix marker must be at the end of the pattern";
    }
    if (content === ":*") {
      return "the command prefix before \":*\" cannot be empty";
    }
  } else if (FILE_PATTERN_TOOLS.has(toolName)) {
    if (content.includes(":*")) {
      return "the \":*\" syntax is Bash-only — use glob patterns (* or **) for files";
    }
  }
  return null;
}

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

    // schema-valid — defer to the JSON Schema auto-extracted from Claude Code's
    // settings validator for the ~113 structurally-unchecked top-level fields.
    // The hand-written rules below cover Claude-Code-specific advice the schema
    // can't express (permission-rule syntax, scope semantics, …) with friendlier
    // messages. The extracted schema is intentionally permissive at the top
    // level (Claude Code uses .passthrough()), so unknown keys are NOT reported
    // here — settings-json/no-unknown-fields handles those. Skipped silently if
    // the schema bundle isn't shipped with this install.
    if (isRuleEnabled(config, "settings-json/schema-valid")) {
      const compiled = loadSettingsSchema();
      if (compiled) {
        const ok = compiled.validate(parsed);
        if (!ok && compiled.validate.errors) {
          const filtered = summarizeErrors(compiled.validate.errors);
          for (const err of filtered) {
            const firstSeg = err.instancePath.split("/").filter(Boolean)[0];
            const p = firstSeg ? findKeyPosition(content, firstSeg) : undefined;
            push(diag(config, filePath, "settings-json/schema-valid", "error",
              formatAjvError(err), p?.line, p?.column));
          }
        }
      }
    }

    // gitea#4: `.claude/settings.json` is a first-class project settings source
    // (`projectSettings`, committed/shared) distinct from `.claude/settings.local.json`
    // (`localSettings`, gitignored). Claude Code's bundle defines both:
    //   `case "projectSettings": return Rk.join(".claude","settings.json")`
    //   `case "localSettings":   return "project, gitignored"`
    // The rule no longer fires for plain project-level settings.json; the
    // `misplaced-file/canonical-location` rule covers files at the wrong path.

    // Determine which fields are valid for this scope. gitea#2: the legacy
    // SETTINGS_PROJECT_FIELDS whitelist is too narrow — Claude Code accepts
    // most user-level fields at project scope too. We now treat all known
    // user fields as valid at project scope, except a small denylist of
    // genuinely user-only fields (auth helpers, plugin enablement, dangerous
    // mode), which still warn via `settings-json/scope-field`.
    const knownFields = SETTINGS_USER_FIELDS;

    // Fields that genuinely only take effect at user scope. Project-scope
    // versions are silently ignored by Claude Code. Source: bundle inspection
    // (auth helpers run from user creds; enabledPlugins / skip-permission
    // flags can't be enabled by a checked-in repo for security reasons).
    const USER_ONLY_FIELDS = new Set<string>([
      "apiKeyHelper",
      "awsAuthRefresh",
      "awsCredentialExport",
      "gcpAuthRefresh",
      "proxyAuthHelper",
      "policyHelper",
      "enabledPlugins",
      "skipDangerousModePermissionPrompt",
      "forceLoginMethod",
      "forceLoginOrgUUID",
    ]);

    // unknown / misplaced top-level fields
    for (const key of Object.keys(parsed)) {
      if (!knownFields.has(key)) {
        const p = findKeyPosition(content, key);
        push(diag(config, filePath, "settings-json/no-unknown-fields", "warning",
          `Unknown top-level field "${key}"`, p?.line, p?.column));
        continue;
      }
      // gitea#2: only the genuinely user-only denylist warns at project scope.
      if (USER_ONLY_FIELDS.has(key) && scope && scope !== "user") {
        const p = findKeyPosition(content, key);
        push(diag(config, filePath, "settings-json/scope-field", "warning",
          `"${key}" only takes effect at user level (~/.claude/settings.json); it is ignored in project settings`, p?.line, p?.column));
      }
    }

    // Validate the sub-keys of a nested object against a known-field set and a
    // type map (used for sandbox.network and sandbox.filesystem).
    const checkNested = (
      obj: Record<string, unknown>,
      prefix: string,
      known: Set<string>,
      types: Record<string, FieldType>,
    ) => {
      for (const [key, val] of Object.entries(obj)) {
        const kp = findKeyPosition(content, key);
        if (!known.has(key)) {
          push(diag(config, filePath, "settings-json/sandbox-unknown-field", "warning",
            `Unknown field "${prefix}.${key}"`, kp?.line, kp?.column));
          continue;
        }
        const expected = types[key];
        if (expected && !typeMatches(expected, val)) {
          push(diag(config, filePath, "settings-json/sandbox-field-type", "warning",
            `"${prefix}.${key}" should be ${articleType(expected)}`, kp?.line, kp?.column));
        }
      }
    };

    // permissions
    if ("permissions" in parsed) {
      const perms = parsed.permissions;
      const pp = findKeyPosition(content, "permissions");
      if (!isPlainObject(perms)) {
        push(diag(config, filePath, "settings-json/permissions-object", "error",
          "\"permissions\" must be an object", pp?.line, pp?.column));
      } else {
        const p = perms;

        // unknown permissions sub-keys
        for (const key of Object.keys(p)) {
          if (!PERMISSIONS_FIELDS.has(key)) {
            const kp = findKeyPosition(content, key);
            push(diag(config, filePath, "settings-json/permissions-unknown-field", "warning",
              `Unknown field "permissions.${key}"`, kp?.line, kp?.column));
          }
        }

        // allow / deny / ask — each an array of permission-rule strings
        const checkRuleArray = (name: "allow" | "deny" | "ask", arrayRuleId: string) => {
          if (!(name in p)) return;
          const kp = findKeyPosition(content, name);
          if (!Array.isArray(p[name])) {
            push(diag(config, filePath, arrayRuleId, "error",
              `"permissions.${name}" must be an array of strings`, kp?.line, kp?.column));
            return;
          }
          for (const entry of p[name] as unknown[]) {
            if (typeof entry !== "string") {
              push(diag(config, filePath, arrayRuleId, "error",
                `"permissions.${name}" entries must be strings (got ${typeof entry})`, kp?.line, kp?.column));
              continue;
            }
            // Syntax first — a malformed rule string is rejected at runtime.
            const syntaxErr = ruleSyntaxError(entry);
            if (syntaxErr) {
              push(diag(config, filePath, "settings-json/permission-rule-syntax", "error",
                `Invalid permission rule "${entry}" in permissions.${name}: ${syntaxErr}`, kp?.line, kp?.column));
              continue;
            }
            // Per-tool pattern grammar (Bash :* placement, WebFetch domain:, …).
            const { toolName, content: ruleContent } = parseRule(entry);
            if (ruleContent !== null) {
              const patternErr = ruleContentError(toolName, ruleContent);
              if (patternErr) {
                push(diag(config, filePath, "settings-json/permission-rule-pattern", "error",
                  `Invalid permission rule "${entry}" in permissions.${name}: ${patternErr}`, kp?.line, kp?.column));
                continue;
              }
            }
            // Rules are "Tool" or "Tool(specifier)". Warn on a base tool name
            // Claude Code does not expose (mcp__* is dynamic).
            const toolMatch = entry.match(/^([A-Za-z]+)(\(.*\))?$/);
            if (toolMatch && !TOOLS.has(toolMatch[1]) && !entry.startsWith("mcp__")) {
              push(diag(config, filePath, "settings-json/allow-known-tools", "warning",
                `Unknown tool "${toolMatch[1]}" in permissions.${name}`, kp?.line, kp?.column));
            }
          }
        };
        checkRuleArray("allow", "settings-json/allow-array");
        checkRuleArray("deny", "settings-json/deny-array");
        checkRuleArray("ask", "settings-json/ask-array");

        // defaultMode — must be a known permission mode
        if ("defaultMode" in p) {
          const mp = findKeyPosition(content, "defaultMode");
          if (typeof p.defaultMode !== "string" || !PERMISSION_MODES.has(p.defaultMode)) {
            push(diag(config, filePath, "settings-json/permissions-default-mode", "warning",
              `"permissions.defaultMode" should be one of: ${[...PERMISSION_MODES].join(", ")}`, mp?.line, mp?.column));
          }
        }

        // disableBypassPermissionsMode — the only accepted value is "disable"
        if ("disableBypassPermissionsMode" in p && p.disableBypassPermissionsMode !== "disable") {
          const dp = findKeyPosition(content, "disableBypassPermissionsMode");
          push(diag(config, filePath, "settings-json/permissions-disable-bypass", "warning",
            "\"permissions.disableBypassPermissionsMode\" only accepts the string \"disable\"", dp?.line, dp?.column));
        }

        // additionalDirectories — array of strings
        if ("additionalDirectories" in p && !isStringArray(p.additionalDirectories)) {
          const ap = findKeyPosition(content, "additionalDirectories");
          push(diag(config, filePath, "settings-json/permissions-field-type", "warning",
            "\"permissions.additionalDirectories\" should be an array of strings", ap?.line, ap?.column));
        }

        // disableAutoMode — boolean
        if ("disableAutoMode" in p && typeof p.disableAutoMode !== "boolean") {
          const ap = findKeyPosition(content, "disableAutoMode");
          push(diag(config, filePath, "settings-json/permissions-field-type", "warning",
            "\"permissions.disableAutoMode\" should be a boolean", ap?.line, ap?.column));
        }
      }
    }

    // sandbox
    if ("sandbox" in parsed) {
      const sandbox = parsed.sandbox;
      const sp = findKeyPosition(content, "sandbox");
      if (!isPlainObject(sandbox)) {
        push(diag(config, filePath, "settings-json/sandbox-object", "error",
          "\"sandbox\" must be an object", sp?.line, sp?.column));
      } else {
        for (const [key, val] of Object.entries(sandbox)) {
          const kp = findKeyPosition(content, key);
          if (!SANDBOX_FIELDS.has(key)) {
            push(diag(config, filePath, "settings-json/sandbox-unknown-field", "warning",
              `Unknown field "sandbox.${key}"`, kp?.line, kp?.column));
            continue;
          }
          const expected = SANDBOX_FIELD_TYPES[key];
          if (expected && !typeMatches(expected, val)) {
            push(diag(config, filePath, "settings-json/sandbox-field-type", "warning",
              `"sandbox.${key}" should be ${articleType(expected)}`, kp?.line, kp?.column));
            continue;
          }

          // Nested object validation
          if (key === "network" && isPlainObject(val)) {
            checkNested(val, "sandbox.network", SANDBOX_NETWORK_FIELDS, NETWORK_FIELD_TYPES);
            if (isPlainObject(val.tlsTerminate)) {
              checkNested(val.tlsTerminate, "sandbox.network.tlsTerminate",
                new Set(Object.keys(TLS_TERMINATE_FIELD_TYPES)), TLS_TERMINATE_FIELD_TYPES);
            }
          } else if (key === "filesystem" && isPlainObject(val)) {
            checkNested(val, "sandbox.filesystem", SANDBOX_FILESYSTEM_FIELDS, FILESYSTEM_FIELD_TYPES);
          } else if (key === "ripgrep" && isPlainObject(val)) {
            for (const rk of Object.keys(val)) {
              if (rk !== "command" && rk !== "args") {
                const rp = findKeyPosition(content, rk);
                push(diag(config, filePath, "settings-json/sandbox-unknown-field", "warning",
                  `Unknown field "sandbox.ripgrep.${rk}"`, rp?.line, rp?.column));
              }
            }
            if (typeof val.command !== "string") {
              push(diag(config, filePath, "settings-json/sandbox-field-type", "warning",
                "\"sandbox.ripgrep.command\" is required and must be a string", kp?.line, kp?.column));
            }
            if ("args" in val && !isStringArray(val.args)) {
              push(diag(config, filePath, "settings-json/sandbox-field-type", "warning",
                "\"sandbox.ripgrep.args\" should be an array of strings", kp?.line, kp?.column));
            }
          } else if (key === "ignoreViolations" && isPlainObject(val)) {
            for (const [vk, vv] of Object.entries(val)) {
              if (!isStringArray(vv)) {
                const vp = findKeyPosition(content, vk);
                push(diag(config, filePath, "settings-json/sandbox-field-type", "warning",
                  `"sandbox.ignoreViolations.${vk}" should be an array of strings`, vp?.line, vp?.column));
              }
            }
          }
        }
      }
    }

    // env — user-level only
    if ("env" in parsed) {
      const env = parsed.env;
      const envp = findKeyPosition(content, "env");
      if (!isPlainObject(env)) {
        push(diag(config, filePath, "settings-json/env-object", "error",
          "\"env\" must be an object of string key-value pairs", envp?.line, envp?.column));
      } else {
        for (const [key, val] of Object.entries(env)) {
          if (typeof val !== "string") {
            const kp = findKeyPosition(content, key);
            push(diag(config, filePath, "settings-json/env-string-values", "warning",
              `"env.${key}" should be a string (got ${typeof val})`, kp?.line, kp?.column));
          }
        }
      }
    }

    // enabledPlugins — user-level only
    if ("enabledPlugins" in parsed) {
      const plugins = parsed.enabledPlugins;
      const plp = findKeyPosition(content, "enabledPlugins");
      if (!isPlainObject(plugins)) {
        push(diag(config, filePath, "settings-json/plugins-object", "error",
          "\"enabledPlugins\" must be an object", plp?.line, plp?.column));
      } else {
        for (const [key, val] of Object.entries(plugins)) {
          const kp = findKeyPosition(content, key);
          if (typeof val !== "boolean") {
            push(diag(config, filePath, "settings-json/plugins-boolean", "warning",
              `"enabledPlugins.${key}" should be a boolean (got ${typeof val})`, kp?.line, kp?.column));
          }
          if (!key.includes("@")) {
            push(diag(config, filePath, "settings-json/plugins-format", "warning",
              `Plugin key "${key}" should be in "name@marketplace" format`, kp?.line, kp?.column));
          }
        }
      }
    }

    // skipDangerousModePermissionPrompt — user-level only
    if ("skipDangerousModePermissionPrompt" in parsed) {
      if (typeof parsed.skipDangerousModePermissionPrompt !== "boolean") {
        const sp = findKeyPosition(content, "skipDangerousModePermissionPrompt");
        push(diag(config, filePath, "settings-json/skip-prompt-boolean", "error",
          "\"skipDangerousModePermissionPrompt\" must be a boolean", sp?.line, sp?.column));
      }
    }

    return diagnostics;
  },
};

export { RULES as SETTINGS_JSON_RULES };
