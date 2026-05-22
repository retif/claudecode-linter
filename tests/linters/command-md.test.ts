import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandMdLinter } from "../../src/linters/command-md.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lintFile(path: string) {
  return commandMdLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("command-md linter", () => {
  it("passes for valid command", () => {
    const diags = lintFile(resolve(FIXTURES, "valid-plugin/commands/example-command.md"));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports missing description", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/command-md/missing-description.md"));
    expect(diags.some((d) => d.rule === "command-md/description-required")).toBe(true);
  });

  it("reports unknown tools", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/command-md/bad-tools.md"));
    const toolWarns = diags.filter((d) => d.rule === "command-md/allowed-tools-valid");
    expect(toolWarns).toHaveLength(1);
    expect(toolWarns[0].message).toContain("FakeToolName");
  });

  it("reports empty body", () => {
    const content = "---\ndescription: A command\n---\n";
    const diags = commandMdLinter.lint("test.md", content, CONFIG);
    expect(diags.some((d) => d.rule === "command-md/body-present")).toBe(true);
  });

  it("reports missing frontmatter", () => {
    const content = "# Just a markdown file\n\nNo frontmatter here.";
    const diags = commandMdLinter.lint("test.md", content, CONFIG);
    expect(diags.some((d) => d.rule === "command-md/valid-frontmatter")).toBe(true);
  });

  it("reports a cross-artifact frontmatter key as info", () => {
    // `effort` is agent frontmatter — misplaced on a command.
    const content = "---\ndescription: A command\neffort: high\n---\n\nDo the thing.";
    const diags = commandMdLinter.lint("test.md", content, CONFIG);
    const unknowns = diags.filter((d) => d.rule === "command-md/no-unknown-frontmatter");
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].severity).toBe("info");
    expect(unknowns[0].message).toContain("effort");
    expect(unknowns[0].message).toContain("agent");
  });

  it("stays silent on a made-up frontmatter key", () => {
    const content = "---\ndescription: A command\ncustom-field: hello\n---\n\nDo the thing.";
    const diags = commandMdLinter.lint("test.md", content, CONFIG);
    expect(diags.filter((d) => d.rule === "command-md/no-unknown-frontmatter")).toHaveLength(0);
  });

  it("does not report allowed-tools or argument-hint as unknown", () => {
    const content = "---\ndescription: A command\nallowed-tools: [Read, Write]\nargument-hint: file path\n---\n\nDo the thing.";
    const diags = commandMdLinter.lint("test.md", content, CONFIG);
    expect(diags.filter((d) => d.rule === "command-md/no-unknown-frontmatter")).toHaveLength(0);
  });
});

// ───────────── auto-extracted JSON Schema rule (schema-valid) ─────────────

describe("command-md — schema-valid (auto-extracted JSON Schema)", () => {
  it("does not flag valid command frontmatter", () => {
    const diags = commandMdLinter.lint(
      "cmd.md",
      "---\ndescription: Does a thing\nargument-hint: <file>\nallowed-tools: [Read]\n---\n\nRun the thing.",
      CONFIG,
    );
    expect(diags.some((d) => d.rule === "command-md/schema-valid")).toBe(false);
  });

  it("flags a structurally-wrong field type", () => {
    // `allowed-tools` must be a string or string array, never an object.
    const diags = commandMdLinter.lint(
      "cmd.md",
      "---\ndescription: Does a thing\nallowed-tools:\n  a: b\n---\n\nRun the thing.",
      CONFIG,
    );
    const d = diags.find((x) => x.rule === "command-md/schema-valid");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain("allowed-tools");
  });

  it("flags a malformed `argument-hint` field (previously-hollow, now typed)", () => {
    // `argument-hint` is `LW()` — z.union([string,number,boolean,null]). Before
    // the LW/z36 walker fix this was a bare `{}` placeholder; a YAML list value
    // must now be rejected.
    const diags = commandMdLinter.lint(
      "cmd.md",
      "---\ndescription: Does a thing\nargument-hint:\n  - a\n  - b\n---\n\nRun the thing.",
      CONFIG,
    );
    const d = diags.find((x) => x.rule === "command-md/schema-valid");
    expect(d).toBeDefined();
    expect(d?.message).toContain("argument-hint");
  });

  it("still accepts a boolean `disable-model-invocation` (LW union permits boolean)", () => {
    // `disable-model-invocation` is `lFH()` — the same string/number/boolean/
    // null union. A real boolean value must not be flagged.
    const diags = commandMdLinter.lint(
      "cmd.md",
      "---\ndescription: Does a thing\ndisable-model-invocation: true\n---\n\nRun the thing.",
      CONFIG,
    );
    expect(diags.some((d) => d.rule === "command-md/schema-valid")).toBe(false);
  });

  it("does not flag unknown frontmatter keys (schema is permissive)", () => {
    const diags = commandMdLinter.lint(
      "cmd.md",
      "---\ndescription: Does a thing\ntotallyUnknownKey: 7\n---\n\nRun the thing.",
      CONFIG,
    );
    expect(diags.some((d) => d.rule === "command-md/schema-valid")).toBe(false);
  });

  it("is silenced when the rule is disabled", () => {
    const diags = commandMdLinter.lint(
      "cmd.md",
      "---\ndescription: Does a thing\nallowed-tools:\n  a: b\n---\n\nRun the thing.",
      { rules: { "command-md/schema-valid": false } },
    );
    expect(diags.some((d) => d.rule === "command-md/schema-valid")).toBe(false);
  });
});
