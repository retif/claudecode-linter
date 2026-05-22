import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mcpJsonLinter } from "../../src/linters/mcp-json.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lint(content: string) {
  return mcpJsonLinter.lint("test.json", content, CONFIG);
}

function lintFile(path: string) {
  return mcpJsonLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("mcp-json linter", () => {
  it("passes for valid mcp.json", () => {
    const diags = lintFile(resolve(FIXTURES, "valid-plugin/.mcp.json"));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports invalid JSON", () => {
    const diags = lint("{bad json");
    expect(diags.some((d) => d.rule === "mcp-json/valid-json")).toBe(true);
  });

  it("reports missing mcpServers", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/missing-servers.json"));
    expect(diags.some((d) => d.rule === "mcp-json/servers-required")).toBe(true);
  });

  it("reports server missing transport", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/server-transport")).toBe(true);
  });

  it("reports invalid URL", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/url-valid")).toBe(true);
  });

  it("reports non-kebab-case server name", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/server-name-kebab")).toBe(true);
  });

  it("reports type mismatch with transport", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/type-matches-transport")).toBe(true);
  });

  it("reports unknown root fields", () => {
    const diags = lint(JSON.stringify({
      mcpServers: { "test-server": { command: "cmd" } },
      extraField: true,
    }));
    expect(diags.some((d) => d.rule === "mcp-json/no-unknown-root-fields")).toBe(true);
  });

  it("reports args not array", () => {
    const diags = lint(JSON.stringify({
      mcpServers: { test: { command: "cmd", args: "not-array" } },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/args-array")).toBe(true);
  });

  it("reports env not object", () => {
    const diags = lint(JSON.stringify({
      mcpServers: { test: { command: "cmd", env: "bad" } },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/env-object")).toBe(true);
  });

  it("accepts valid http server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "http", url: "https://example.com/mcp" },
      },
    }));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("accepts streamable-http type on a URL server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "streamable-http", url: "https://example.com/mcp" },
      },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/type-matches-transport")).toBe(false);
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("still flags a bogus type on a URL server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "stdio", url: "https://example.com/mcp" },
      },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/type-matches-transport")).toBe(true);
  });

  it("accepts valid stdio server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "local-server": { command: "/usr/bin/mcp", args: ["--port", "3000"] },
      },
    }));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("warns .mcp.json at user level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint(".mcp.json", content, CONFIG, "user");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(true);
  });

  it("warns mcp.json at project level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint("mcp.json", content, CONFIG, "project");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(true);
  });

  it("accepts mcp.json at user level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint("mcp.json", content, CONFIG, "user");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(false);
  });

  it("accepts .mcp.json at project level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint(".mcp.json", content, CONFIG, "project");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(false);
  });

  describe("schema-valid", () => {
    it("does not flag a valid .mcp.json", () => {
      const diags = lintFile(resolve(FIXTURES, "valid-plugin/.mcp.json"));
      expect(diags.some((d) => d.rule === "mcp-json/schema-valid")).toBe(false);
    });

    it("flags a malformed server field type", () => {
      const diags = lintFile(
        resolve(FIXTURES, "invalid/mcp-json/bad-schema-types.json"),
      );
      const schemaErrors = diags.filter(
        (d) => d.rule === "mcp-json/schema-valid",
      );
      expect(schemaErrors.length).toBeGreaterThan(0);
      expect(schemaErrors.every((d) => d.severity === "error")).toBe(true);
    });

    it("respects the rule being disabled", () => {
      const diags = mcpJsonLinter.lint(
        ".mcp.json",
        readFileSync(
          resolve(FIXTURES, "invalid/mcp-json/bad-schema-types.json"),
          "utf-8",
        ),
        { rules: { "mcp-json/schema-valid": false } },
      );
      expect(diags.some((d) => d.rule === "mcp-json/schema-valid")).toBe(false);
    });
  });
});
