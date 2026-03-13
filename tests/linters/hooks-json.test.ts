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
});
