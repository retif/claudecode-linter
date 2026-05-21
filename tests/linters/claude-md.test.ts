import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { claudeMdLinter } from "../../src/linters/claude-md.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lint(content: string) {
  return claudeMdLinter.lint("CLAUDE.md", content, CONFIG);
}

function lintFile(path: string) {
  return claudeMdLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("claude-md linter", () => {
  it("passes for valid CLAUDE.md", () => {
    const diags = lintFile(resolve(FIXTURES, "valid-plugin/CLAUDE.md"));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports empty file", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/claude-md/empty.md"));
    expect(diags.some((d) => d.rule === "claude-md/not-empty")).toBe(true);
  });

  it("reports missing heading at start", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/claude-md/no-heading.md"));
    expect(diags.some((d) => d.rule === "claude-md/starts-with-heading")).toBe(true);
  });

  it("reports missing H2 sections", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/claude-md/no-heading.md"));
    expect(diags.some((d) => d.rule === "claude-md/has-sections")).toBe(true);
  });

  it("reports potential secrets", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/claude-md/has-secret.md"));
    expect(diags.some((d) => d.rule === "claude-md/no-secrets")).toBe(true);
    expect(diags.find((d) => d.rule === "claude-md/no-secrets")?.severity).toBe("error");
  });

  it("reports TODO markers", () => {
    const diags = lint("# Project\n\n## Setup\n\nTODO: Add installation steps\n\nFIXME: broken link");
    const todos = diags.filter((d) => d.rule === "claude-md/no-todo-markers");
    expect(todos).toHaveLength(2);
  });

  it("reports large file", () => {
    const lines = ["# Project", "", "## Section", ""];
    for (let i = 0; i < 500; i++) lines.push(`Line ${i}`);
    const diags = lint(lines.join("\n"));
    expect(diags.some((d) => d.rule === "claude-md/file-length")).toBe(true);
  });

  it("reports absolute paths in links", () => {
    const diags = lint("# Project\n\n## Links\n\nSee [config](/etc/nixos/config.nix) for details.");
    expect(diags.some((d) => d.rule === "claude-md/no-absolute-paths")).toBe(true);
  });

  it("does not flag URL links", () => {
    const diags = lint("# Project\n\n## Links\n\nSee [docs](https://example.com) for details.");
    expect(diags.some((d) => d.rule === "claude-md/no-absolute-paths")).toBe(false);
  });

  it("reports trailing whitespace", () => {
    const diags = lint("# Project  \n\n## Section\n\nSome text   \n");
    expect(diags.some((d) => d.rule === "claude-md/no-trailing-whitespace")).toBe(true);
  });

  it("warns user-level CLAUDE.md over 100 lines", () => {
    const lines = ["# Global Rules", "", "## Conventions"];
    for (let i = 0; i < 100; i++) lines.push(`Rule ${i}`);
    const diags = claudeMdLinter.lint("CLAUDE.md", lines.join("\n"), CONFIG, "user");
    expect(diags.some((d) => d.rule === "claude-md/user-level-concise")).toBe(true);
  });

  it("does not warn project-level CLAUDE.md over 100 lines", () => {
    const lines = ["# Project", "", "## Overview"];
    for (let i = 0; i < 100; i++) lines.push(`Detail ${i}`);
    const diags = claudeMdLinter.lint("CLAUDE.md", lines.join("\n"), CONFIG, "project");
    expect(diags.some((d) => d.rule === "claude-md/user-level-concise")).toBe(false);
  });

  it("suggests project overview section when missing", () => {
    const diags = claudeMdLinter.lint("CLAUDE.md", "# My Tool\n\n## Build\n\nnpm run build\n", CONFIG, "project");
    expect(diags.some((d) => d.rule === "claude-md/project-has-overview")).toBe(true);
  });

  it("does not suggest overview when present", () => {
    const diags = claudeMdLinter.lint("CLAUDE.md", "# Project\n\n## Project Overview\n\nThis is a tool.\n", CONFIG, "project");
    expect(diags.some((d) => d.rule === "claude-md/project-has-overview")).toBe(false);
  });

  it("accepts descriptive opening prose in place of an Overview heading", () => {
    const content =
      "# rust-craft Plugin\n\nRust development knowledge for NixOS environments — toolchain management and pitfalls.\n\n## Skills\n\n- rust-nix-toolchain\n";
    const diags = claudeMdLinter.lint("CLAUDE.md", content, CONFIG, "project");
    expect(diags.some((d) => d.rule === "claude-md/project-has-overview")).toBe(false);
  });
});
