import { describe, it, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, mergeCliRules } from "../src/config.js";
import { isRuleEnabled, getRuleSeverity } from "../src/types.js";

describe("config", () => {
  it("returns default config when no file exists", () => {
    const config = loadConfig("/nonexistent/path/.claudecode-lint.yaml");
    expect(config.rules).toEqual({});
  });

  it("loads config from yaml file", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudecode-linter-test-"));
    const path = join(dir, ".claudecode-lint.yaml");
    writeFileSync(path, 'rules:\n  plugin-json/no-unknown-fields: false\n  skill-md/body-word-count:\n    enabled: true\n    severity: info\n');

    try {
      const config = loadConfig(path);
      expect(config.rules["plugin-json/no-unknown-fields"]).toBe(false);
      expect(config.rules["skill-md/body-word-count"]).toEqual({ enabled: true, severity: "info" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // oleks/claudecode-linter#14: the shipped .claudecode-lint.defaults.yaml
  // writes every rule as a bare severity scalar, and that form used to be
  // dropped on the floor — no error, no warning, no effect.
  it.each(["error", "warning", "info"] as const)(
    "honours a bare %s severity scalar",
    (severity) => {
      const dir = mkdtempSync(join(tmpdir(), "claudecode-linter-test-"));
      const path = join(dir, ".claudecode-lint.yaml");
      writeFileSync(path, `rules:\n  agent-md/mcp-tools-resolve: ${severity}\n`);

      try {
        const config = loadConfig(path);
        expect(config.rules["agent-md/mcp-tools-resolve"]).toEqual({
          enabled: true,
          severity,
        });
        expect(isRuleEnabled(config, "agent-md/mcp-tools-resolve")).toBe(true);
        expect(getRuleSeverity(config, "agent-md/mcp-tools-resolve", "error")).toBe(severity);
      } finally {
        rmSync(dir, { recursive: true });
      }
    },
  );

  // `severity` without `enabled` used to leave enabled undefined, so asking to
  // DOWNGRADE a rule silently SILENCED it instead.
  it("treats an object with only a severity as enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudecode-linter-test-"));
    const path = join(dir, ".claudecode-lint.yaml");
    writeFileSync(path, "rules:\n  skill-md/body-word-count:\n    severity: info\n");

    try {
      const config = loadConfig(path);
      expect(isRuleEnabled(config, "skill-md/body-word-count")).toBe(true);
      expect(getRuleSeverity(config, "skill-md/body-word-count", "error")).toBe("info");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("reports an unusable rule value instead of dropping it silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudecode-linter-test-"));
    const path = join(dir, ".claudecode-lint.yaml");
    writeFileSync(path, "rules:\n  skill-md/body-word-count: quiet\n");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const config = loadConfig(path);
      expect(config.rules["skill-md/body-word-count"]).toBeUndefined();
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("skill-md/body-word-count");
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });

  it("still honours the documented boolean and object forms", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudecode-linter-test-"));
    const path = join(dir, ".claudecode-lint.yaml");
    writeFileSync(
      path,
      "rules:\n  plugin-json/no-unknown-fields: false\n  claude-md/file-length:\n    enabled: true\n    severity: error\n",
    );

    try {
      const config = loadConfig(path);
      expect(isRuleEnabled(config, "plugin-json/no-unknown-fields")).toBe(false);
      expect(config.rules["claude-md/file-length"]).toEqual({ enabled: true, severity: "error" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("merges CLI rule overrides", () => {
    const base = { rules: { "plugin-json/name-required": true as const } };
    const merged = mergeCliRules(base, ["skill-md/name-required"], ["plugin-json/name-required"]);
    expect(merged.rules["skill-md/name-required"]).toBe(true);
    expect(merged.rules["plugin-json/name-required"]).toBe(false);
  });
});
