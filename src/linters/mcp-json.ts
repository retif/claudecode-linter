import { basename } from "node:path";
import type { Linter, LintDiagnostic, LinterConfig, Severity, ConfigScope } from "../types.js";
import { isRuleEnabled, getRuleSeverity } from "../types.js";
import { isKebabCase } from "../utils/kebab-case.js";

interface RuleDef { id: string; defaultSeverity: Severity; }

const RULES: RuleDef[] = [
  { id: "mcp-json/scope-file-name", defaultSeverity: "warning" },
  { id: "mcp-json/valid-json", defaultSeverity: "error" },
  { id: "mcp-json/servers-required", defaultSeverity: "error" },
  { id: "mcp-json/servers-object", defaultSeverity: "error" },
  { id: "mcp-json/server-name-kebab", defaultSeverity: "info" },
  { id: "mcp-json/server-object", defaultSeverity: "error" },
  { id: "mcp-json/server-transport", defaultSeverity: "error" },
  { id: "mcp-json/url-protocol", defaultSeverity: "warning" },
  { id: "mcp-json/url-valid", defaultSeverity: "error" },
  { id: "mcp-json/type-matches-transport", defaultSeverity: "warning" },
  { id: "mcp-json/command-args-split", defaultSeverity: "info" },
  { id: "mcp-json/args-array", defaultSeverity: "error" },
  { id: "mcp-json/env-object", defaultSeverity: "error" },
  { id: "mcp-json/env-string-values", defaultSeverity: "warning" },
  { id: "mcp-json/no-unknown-server-fields", defaultSeverity: "info" },
  { id: "mcp-json/no-unknown-root-fields", defaultSeverity: "info" },
];

const KNOWN_SERVER_FIELDS = new Set([
  "type", "url", "command", "args", "env", "cwd",
]);

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

export const mcpJsonLinter: Linter = {
  artifactType: "mcp-json",

  lint(filePath: string, content: string, config: LinterConfig, scope?: ConfigScope): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const push = (d: LintDiagnostic | null) => { if (d) diagnostics.push(d); };
    const fileName = basename(filePath);

    // Scope-aware file naming: user level = mcp.json, project level = .mcp.json
    if (scope === "user" && fileName === ".mcp.json") {
      push(diag(config, filePath, "mcp-json/scope-file-name", "warning",
        "At user level (~/.claude/), use \"mcp.json\" instead of \".mcp.json\""));
    }
    if (scope === "project" && fileName === "mcp.json") {
      push(diag(config, filePath, "mcp-json/scope-file-name", "warning",
        "At project level, use \".mcp.json\" (dot-prefixed) instead of \"mcp.json\""));
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      push(diag(config, filePath, "mcp-json/valid-json", "error",
        `Invalid JSON: ${(e as Error).message}`));
      return diagnostics;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      push(diag(config, filePath, "mcp-json/valid-json", "error",
        "mcp.json must be a JSON object"));
      return diagnostics;
    }

    // mcpServers required
    if (!("mcpServers" in parsed)) {
      push(diag(config, filePath, "mcp-json/servers-required", "error",
        "\"mcpServers\" field is required"));
      return diagnostics;
    }

    const servers = parsed.mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      push(diag(config, filePath, "mcp-json/servers-object", "error",
        "\"mcpServers\" must be an object"));
      return diagnostics;
    }

    for (const [name, serverDef] of Object.entries(servers as Record<string, unknown>)) {
      const sp = findKeyPosition(content, name);
      // server name convention
      if (!isKebabCase(name)) {
        push(diag(config, filePath, "mcp-json/server-name-kebab", "info",
          `Server name "${name}" should be kebab-case`, sp?.line, sp?.column));
      }

      if (typeof serverDef !== "object" || serverDef === null || Array.isArray(serverDef)) {
        push(diag(config, filePath, "mcp-json/server-object", "error",
          `Server "${name}" must be an object`, sp?.line, sp?.column));
        continue;
      }

      const server = serverDef as Record<string, unknown>;

      // Must have either type+url (http) or command (stdio)
      const hasUrl = "url" in server && typeof server.url === "string";
      const hasCommand = "command" in server && typeof server.command === "string";

      if (!hasUrl && !hasCommand) {
        push(diag(config, filePath, "mcp-json/server-transport", "error",
          `Server "${name}" must have either "url" (http) or "command" (stdio)`, sp?.line, sp?.column));
        continue;
      }

      // http server checks
      if (hasUrl) {
        const url = server.url as string;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            push(diag(config, filePath, "mcp-json/url-protocol", "warning",
              `Server "${name}" URL uses "${parsed.protocol}" — expected http: or https:`, sp?.line, sp?.column));
          }
        } catch {
          push(diag(config, filePath, "mcp-json/url-valid", "error",
            `Server "${name}" has invalid URL: "${url}"`, sp?.line, sp?.column));
        }

        if ("type" in server && server.type !== "http") {
          push(diag(config, filePath, "mcp-json/type-matches-transport", "warning",
            `Server "${name}" has URL but type is "${server.type}" (expected "http")`, sp?.line, sp?.column));
        }
      }

      // stdio server checks
      if (hasCommand && !hasUrl) {
        const cmd = server.command as string;
        if (cmd.includes(" ") && !("args" in server)) {
          push(diag(config, filePath, "mcp-json/command-args-split", "info",
            `Server "${name}" command contains spaces — consider splitting into "command" and "args"`, sp?.line, sp?.column));
        }
      }

      // args must be array
      if ("args" in server && !Array.isArray(server.args)) {
        push(diag(config, filePath, "mcp-json/args-array", "error",
          `Server "${name}" "args" must be an array`, sp?.line, sp?.column));
      }

      // env must be object of strings
      if ("env" in server) {
        if (typeof server.env !== "object" || server.env === null || Array.isArray(server.env)) {
          push(diag(config, filePath, "mcp-json/env-object", "error",
            `Server "${name}" "env" must be an object`, sp?.line, sp?.column));
        } else {
          for (const [k, v] of Object.entries(server.env as Record<string, unknown>)) {
            if (typeof v !== "string") {
              push(diag(config, filePath, "mcp-json/env-string-values", "warning",
                `Server "${name}" env.${k} should be a string`, sp?.line, sp?.column));
            }
          }
        }
      }

      // unknown fields
      for (const key of Object.keys(server)) {
        if (!KNOWN_SERVER_FIELDS.has(key)) {
          push(diag(config, filePath, "mcp-json/no-unknown-server-fields", "info",
            `Server "${name}" has unknown field "${key}"`, sp?.line, sp?.column));
        }
      }
    }

    // unknown root fields
    for (const key of Object.keys(parsed)) {
      if (key !== "mcpServers") {
        const p = findKeyPosition(content, key);
        push(diag(config, filePath, "mcp-json/no-unknown-root-fields", "info",
          `Unknown root field "${key}" (expected only "mcpServers")`, p?.line, p?.column));
      }
    }

    return diagnostics;
  },
};

export { RULES as MCP_JSON_RULES };
