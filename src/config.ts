import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { LinterConfig, RuleConfig, Severity } from "./types.js";
import { assetCandidates } from "./utils/asset-path.js";

const DEFAULT_CONFIG: LinterConfig = {
  rules: {},
};

const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/**
 * Normalise one `rules:` entry into the internal `RuleConfig | boolean` shape.
 *
 * Three surface forms are accepted, because all three are forms the shipped
 * `.claudecode-lint.defaults.yaml` teaches by example:
 *
 *   rule: false                             -> disabled
 *   rule: info                              -> enabled at that severity
 *   rule: { enabled: true, severity: info } -> enabled at that severity
 *
 * The scalar severity form used to be dropped on the floor: every rule in the
 * defaults file is written that way (`agent-md/valid-frontmatter: error`), so
 * copying that file and changing a severity produced no error, no warning and
 * no effect, while the sibling `false` scalar was honoured
 * (oleks/claudecode-linter#14).
 *
 * `severity` without `enabled` is likewise treated as enabled. `enabled` is
 * declared required on RuleConfig, so omitting it made `isRuleEnabled` read
 * `undefined` and switch the rule OFF entirely — a request to DOWNGRADE a rule
 * silently SILENCED it, the opposite of what was written.
 *
 * Returns undefined for a value that is none of these, so the caller can say so
 * rather than ignore it.
 */
function normalizeRule(value: unknown): RuleConfig | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (isSeverity(value)) return { enabled: true, severity: value };
  if (typeof value === "object" && value !== null) {
    const obj = value as { enabled?: unknown; severity?: unknown };
    if (obj.severity !== undefined && !isSeverity(obj.severity)) return undefined;
    if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") return undefined;
    const rule: RuleConfig = { enabled: obj.enabled ?? true };
    if (obj.severity !== undefined) rule.severity = obj.severity as Severity;
    return rule;
  }
  return undefined;
}

export function loadConfig(configPath?: string): LinterConfig {
  const path = configPath ?? findConfigFile();
  if (!path) return DEFAULT_CONFIG;

  try {
    const content = readFileSync(path, "utf-8");
    const parsed = parseYaml(content, { maxAliasCount: 100 });
    if (!parsed || typeof parsed !== "object") return DEFAULT_CONFIG;

    const config: LinterConfig = { rules: {} };

    if (parsed.rules && typeof parsed.rules === "object") {
      for (const [key, value] of Object.entries(parsed.rules)) {
        const rule = normalizeRule(value);
        if (rule === undefined) {
          // Never drop an override silently: an unusable entry looked exactly
          // like an accepted one (oleks/claudecode-linter#14). stderr, so
          // `--output json` stays machine-readable on stdout.
          console.error(
            `claudecode-linter: ignoring unusable config for rule "${key}" in ${path}: ` +
              `expected false, one of ${SEVERITIES.join("/")}, or { enabled, severity }`,
          );
          continue;
        }
        config.rules[key] = rule;
      }
    }

    return config;
  } catch (err) {
    // An unreadable or malformed config silently degraded to "no overrides",
    // which is indistinguishable from a config that was honoured — the same
    // silent-no-op shape as the dropped scalar above.
    console.error(
      `claudecode-linter: ignoring unreadable config ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return DEFAULT_CONFIG;
  }
}

function findConfigFile(): string | undefined {
  // 1. Check cwd
  const cwdCandidates = [".claudecode-lint.yaml", ".claudecode-lint.yml"];
  for (const name of cwdCandidates) {
    if (existsSync(name)) return name;
  }

  // 2. Check home directory
  const home = homedir();
  for (const name of cwdCandidates) {
    const homePath = join(home, name);
    if (existsSync(homePath)) return homePath;
  }

  // 3. Fall back to bundled defaults. Resolved relative to import.meta.url
  //    first (Node / npm package), then relative to process.execPath as a
  //    fallback for the `bun build --compile` single-executable variant.
  for (const bundled of assetCandidates(import.meta.url, [
    "..",
    ".claudecode-lint.defaults.yaml",
  ])) {
    if (existsSync(bundled)) return bundled;
  }

  return undefined;
}

export function mergeCliRules(
  config: LinterConfig,
  enable: string[],
  disable: string[],
): LinterConfig {
  const merged = { rules: { ...config.rules } };
  for (const rule of enable) {
    merged.rules[rule] = true;
  }
  for (const rule of disable) {
    merged.rules[rule] = false;
  }
  return merged;
}
