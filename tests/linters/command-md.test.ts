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
