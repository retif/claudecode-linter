import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hooksJsonLinter } from "../../src/linters/hooks-json.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lintFile(path: string) {
  return hooksJsonLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("hooks-json linter", () => {
  it("passes for valid hooks", () => {
    const diags = lintFile(resolve(FIXTURES, "valid-plugin/hooks/hooks.json"));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports invalid JSON", () => {
    const diags = hooksJsonLinter.lint("test.json", "not json {{{", CONFIG);
    expect(diags.some((d) => d.rule === "hooks-json/valid-json")).toBe(true);
  });

  it("reports missing root hooks key", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/hooks-json/no-root-hooks.json"));
    expect(diags.some((d) => d.rule === "hooks-json/root-hooks-key")).toBe(true);
  });

  it("reports invalid event names", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/hooks-json/bad-event.json"));
    expect(diags.some((d) => d.rule === "hooks-json/valid-event-names")).toBe(true);
    expect(diags[0].message).toContain("OnSave");
  });

  it("reports missing hook type", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/hooks-json/missing-type.json"));
    expect(diags.some((d) => d.rule === "hooks-json/hook-type-required")).toBe(true);
  });

  it("reports hardcoded paths", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/hooks-json/hardcoded-path.json"));
    expect(diags.some((d) => d.rule === "hooks-json/no-hardcoded-paths")).toBe(true);
  });

  it("reports timeout out of range", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/hooks-json/bad-timeout.json"));
    expect(diags.some((d) => d.rule === "hooks-json/timeout-range")).toBe(true);
  });

  it("does not report prompt-event-support for SessionEnd (now a valid prompt event)", () => {
    // SessionEnd gained prompt support in Claude Code — all hook events now support prompts
    const diags = lintFile(resolve(FIXTURES, "invalid/hooks-json/prompt-wrong-event.json"));
    expect(diags.some((d) => d.rule === "hooks-json/prompt-event-support")).toBe(false);
  });

  it("reports missing command field on command hook", () => {
    const content = JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Write",
          hooks: [{ type: "command" }],
        }],
      },
    });
    const diags = hooksJsonLinter.lint("test.json", content, CONFIG);
    expect(diags.some((d) => d.rule === "hooks-json/command-has-command")).toBe(true);
  });

  it("reports missing prompt field on prompt hook", () => {
    const content = JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Write",
          hooks: [{ type: "prompt" }],
        }],
      },
    });
    const diags = hooksJsonLinter.lint("test.json", content, CONFIG);
    expect(diags.some((d) => d.rule === "hooks-json/prompt-has-prompt")).toBe(true);
  });

  it("reports invalid hook type", () => {
    const content = JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Write",
          hooks: [{ type: "invalid-type", command: "echo hi" }],
        }],
      },
    });
    const diags = hooksJsonLinter.lint("test.json", content, CONFIG);
    expect(diags.some((d) => d.rule === "hooks-json/hook-type-required")).toBe(true);
    expect(diags[0].message).toContain("command");
  });

  describe("schema-valid", () => {
    it("does not flag a valid hooks.json", () => {
      const diags = lintFile(resolve(FIXTURES, "valid-plugin/hooks/hooks.json"));
      expect(diags.some((d) => d.rule === "hooks-json/schema-valid")).toBe(false);
    });

    it("flags a malformed hook field type", () => {
      const diags = lintFile(
        resolve(FIXTURES, "invalid/hooks-json/bad-schema-types.json"),
      );
      const schemaErrors = diags.filter(
        (d) => d.rule === "hooks-json/schema-valid",
      );
      expect(schemaErrors.length).toBeGreaterThan(0);
      expect(schemaErrors.every((d) => d.severity === "error")).toBe(true);
    });

    it("respects the rule being disabled", () => {
      const diags = hooksJsonLinter.lint(
        "hooks.json",
        readFileSync(
          resolve(FIXTURES, "invalid/hooks-json/bad-schema-types.json"),
          "utf-8",
        ),
        { rules: { "hooks-json/schema-valid": false } },
      );
      expect(diags.some((d) => d.rule === "hooks-json/schema-valid")).toBe(false);
    });

    // Per-branch coverage of the per-hook discriminated union in
    // contracts/hooks.schema.json. The union has 5 branches: command, prompt,
    // agent, http, mcp_tool. Each is structurally typed (const `type`
    // discriminator plus typed required fields) — none are hollow placeholders,
    // so every branch gets both a valid-passes and a malformed-errors test.

    function schemaErrors(hook: unknown) {
      const content = JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Write", hooks: [hook] }] },
      });
      return hooksJsonLinter
        .lint("hooks.json", content, CONFIG)
        .filter((d) => d.rule === "hooks-json/schema-valid");
    }

    describe("per-hook union branches", () => {
      // --- command ---
      it("command: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors({ type: "command", command: "echo hi" }),
        ).toHaveLength(0);
      });
      it("command: command of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "command", command: 42 }).length,
        ).toBeGreaterThan(0);
      });
      it("command: missing required command produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "command" }).length,
        ).toBeGreaterThan(0);
      });

      // --- prompt ---
      it("prompt: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors({ type: "prompt", prompt: "check this" }),
        ).toHaveLength(0);
      });
      it("prompt: prompt of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "prompt", prompt: 42 }).length,
        ).toBeGreaterThan(0);
      });
      it("prompt: missing required prompt produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "prompt" }).length,
        ).toBeGreaterThan(0);
      });

      // --- agent ---
      it("agent: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors({ type: "agent", prompt: "verify tests passed" }),
        ).toHaveLength(0);
      });
      it("agent: prompt of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "agent", prompt: 42 }).length,
        ).toBeGreaterThan(0);
      });
      it("agent: missing required prompt produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "agent" }).length,
        ).toBeGreaterThan(0);
      });

      // --- http ---
      it("http: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors({ type: "http", url: "https://example.com/hook" }),
        ).toHaveLength(0);
      });
      it("http: url of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "http", url: 42 }).length,
        ).toBeGreaterThan(0);
      });
      it("http: malformed url string fails the uri format check", () => {
        expect(
          schemaErrors({ type: "http", url: "not a uri" }).length,
        ).toBeGreaterThan(0);
      });
      it("http: missing required url produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "http" }).length,
        ).toBeGreaterThan(0);
      });

      // --- mcp_tool ---
      it("mcp_tool: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors({ type: "mcp_tool", server: "srv", tool: "mytool" }),
        ).toHaveLength(0);
      });
      it("mcp_tool: server of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "mcp_tool", server: 42, tool: "mytool" }).length,
        ).toBeGreaterThan(0);
      });
      it("mcp_tool: missing required tool produces a schema-valid error", () => {
        expect(
          schemaErrors({ type: "mcp_tool", server: "srv" }).length,
        ).toBeGreaterThan(0);
      });
      it("mcp_tool: non-object input produces a schema-valid error", () => {
        expect(
          schemaErrors({
            type: "mcp_tool",
            server: "srv",
            tool: "mytool",
            input: "bad",
          }).length,
        ).toBeGreaterThan(0);
      });
      // The mcp_tool branch's `input` is typed `object` but its values are
      // `additionalProperties: {}` — a permissive placeholder. schema-valid can
      // confirm `input` is an object but cannot catch malformed values inside it.
      it("mcp_tool: arbitrary input property values are not validated", () => {
        // input value-level branch is a permissive placeholder — schema-valid
        // cannot catch malformed mcp_tool input payloads
        expect(
          schemaErrors({
            type: "mcp_tool",
            server: "srv",
            tool: "mytool",
            input: { anything: 123, nested: { whatever: true } },
          }),
        ).toHaveLength(0);
      });
    });
  });
});
