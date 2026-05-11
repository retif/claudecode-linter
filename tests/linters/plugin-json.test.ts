import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pluginJsonLinter } from "../../src/linters/plugin-json.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const DEFAULT_CONFIG: LinterConfig = { rules: {} };

function lint(content: string) {
  return pluginJsonLinter.lint("test.json", content, DEFAULT_CONFIG);
}

function lintFile(path: string) {
  const content = readFileSync(path, "utf-8");
  return pluginJsonLinter.lint(path, content, DEFAULT_CONFIG);
}

describe("plugin-json linter", () => {
  it("passes for valid plugin.json", () => {
    const diags = lintFile(resolve(FIXTURES, "valid-plugin/.claude-plugin/plugin.json"));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports invalid JSON", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/invalid.txt"));
    expect(diags).toHaveLength(1);
    expect(diags[0].rule).toBe("plugin-json/valid-json");
    expect(diags[0].severity).toBe("error");
  });

  it("reports missing name", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/missing-name.json"));
    const nameErrors = diags.filter((d) => d.rule === "plugin-json/name-required");
    expect(nameErrors).toHaveLength(1);
    expect(nameErrors[0].severity).toBe("error");
  });

  it("reports non-kebab-case name", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/bad-name.json"));
    const nameErrors = diags.filter((d) => d.rule === "plugin-json/name-kebab-case");
    expect(nameErrors).toHaveLength(1);
  });

  it("reports invalid semver", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/bad-version.json"));
    const versionWarns = diags.filter((d) => d.rule === "plugin-json/version-semver");
    expect(versionWarns).toHaveLength(1);
    expect(versionWarns[0].severity).toBe("warning");
  });

  it("reports duplicate keywords", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/duplicate-keywords.json"));
    const dupWarns = diags.filter((d) => d.rule === "plugin-json/keywords-no-duplicates");
    expect(dupWarns).toHaveLength(1);
  });

  it("reports unknown fields", () => {
    const diags = lint(JSON.stringify({ name: "test", custom: true }));
    const unknowns = diags.filter((d) => d.rule === "plugin-json/no-unknown-fields");
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].message).toContain("custom");
  });

  it("validates author shape", () => {
    const diags = lint(JSON.stringify({ name: "test", author: "just a string" }));
    const authorInfos = diags.filter((d) => d.rule === "plugin-json/author-object");
    expect(authorInfos).toHaveLength(1);
  });

  it("validates repository URL", () => {
    const diags = lint(JSON.stringify({ name: "test", repository: "not-a-url" }));
    const repoWarns = diags.filter((d) => d.rule === "plugin-json/repository-url");
    expect(repoWarns).toHaveLength(1);
  });

  it("accepts valid repository URL", () => {
    const diags = lint(JSON.stringify({
      name: "test",
      repository: "https://github.com/user/repo.git",
    }));
    const repoWarns = diags.filter((d) => d.rule === "plugin-json/repository-url");
    expect(repoWarns).toHaveLength(0);
  });

  it("respects disabled rules via config", () => {
    const config: LinterConfig = {
      rules: { "plugin-json/name-required": false },
    };
    const diags = pluginJsonLinter.lint("test.json", JSON.stringify({}), config);
    const nameErrors = diags.filter((d) => d.rule === "plugin-json/name-required");
    expect(nameErrors).toHaveLength(0);
  });

  it("reports name too long", () => {
    const longName = "a".repeat(65);
    const diags = lint(JSON.stringify({ name: longName }));
    const lengthErrors = diags.filter((d) => d.rule === "plugin-json/name-length");
    expect(lengthErrors).toHaveLength(1);
  });

  describe("plugin-json/schema-valid", () => {
    it("flags wrong type for name", () => {
      const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/wrong-name-type.json"));
      const schema = diags.filter((d) => d.rule === "plugin-json/schema-valid");
      expect(schema.some((d) => d.message.includes("/name") && d.message.includes("string"))).toBe(true);
    });

    it("flags unknown MCP server transport", () => {
      const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/bad-mcp-transport.json"));
      const schema = diags.filter((d) => d.rule === "plugin-json/schema-valid");
      expect(schema.length).toBeGreaterThan(0);
      expect(schema.some((d) => d.message.includes("mcpServers"))).toBe(true);
    });

    it("flags stdio transport missing command", () => {
      const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/stdio-missing-command.json"));
      const schema = diags.filter((d) => d.rule === "plugin-json/schema-valid");
      expect(schema.some((d) => d.message.includes("command"))).toBe(true);
    });

    it("flags invalid userConfig.type enum", () => {
      const diags = lintFile(resolve(FIXTURES, "invalid/plugin-json/bad-user-config-type.json"));
      const schema = diags.filter((d) => d.rule === "plugin-json/schema-valid");
      expect(schema.some((d) => d.message.includes("userConfig") && d.message.includes("one of"))).toBe(true);
    });

    it("respects disable via config", () => {
      const config: LinterConfig = {
        rules: { "plugin-json/schema-valid": false },
      };
      const content = readFileSync(
        resolve(FIXTURES, "invalid/plugin-json/wrong-name-type.json"),
        "utf-8",
      );
      const diags = pluginJsonLinter.lint("test.json", content, config);
      const schema = diags.filter((d) => d.rule === "plugin-json/schema-valid");
      expect(schema).toHaveLength(0);
    });
  });
});
