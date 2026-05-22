import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { LinterConfig, RuleConfig } from "./types.js";
import { assetCandidates } from "./utils/asset-path.js";

const DEFAULT_CONFIG: LinterConfig = {
  rules: {},
};

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
        if (typeof value === "boolean") {
          config.rules[key] = value;
        } else if (typeof value === "object" && value !== null) {
          config.rules[key] = value as RuleConfig;
        }
      }
    }

    return config;
  } catch {
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
