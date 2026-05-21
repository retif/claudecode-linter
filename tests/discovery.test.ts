import { describe, it, expect } from "vitest";
import { resolve, relative } from "node:path";

// Test classifyFile indirectly through discoverArtifacts with single file
import { discoverArtifacts } from "../src/discovery.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

describe("discovery", () => {
  describe("classifyFile for mcp.json", () => {
    it("classifies .mcp.json at project root", () => {
      const artifacts = discoverArtifacts(resolve(FIXTURES, "valid-plugin/.mcp.json"));
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].artifactType).toBe("mcp-json");
    });
  });

  describe("directory discovery", () => {
    it("discovers all artifacts in valid-plugin", () => {
      const artifacts = discoverArtifacts(resolve(FIXTURES, "valid-plugin"));
      const types = artifacts.map((a) => a.artifactType);
      expect(types).toContain("plugin-json");
      expect(types).toContain("skill-md");
      expect(types).toContain("agent-md");
      expect(types).toContain("command-md");
      expect(types).toContain("hooks-json");
      expect(types).toContain("mcp-json");
      expect(types).toContain("claude-md");
    });

    it("ignores artifacts inside .claude/worktrees/ copies", () => {
      // tests/fixtures/valid-plugin/.claude/worktrees/wt-sample/plugin.json
      // is a stray artifact; the recursive misplaced-file scan must skip it.
      // Compare fixture-relative paths — the repo's own worktree lives under
      // .claude/worktrees/, so absolute paths can't be used here.
      const root = resolve(FIXTURES, "valid-plugin");
      const rel = discoverArtifacts(root).map((a) => relative(root, a.filePath));
      expect(rel.some((r) => r.includes(".claude/worktrees/"))).toBe(false);
    });
  });

  describe("ignore support", () => {
    it("filters artifacts matching ignore patterns", () => {
      const all = discoverArtifacts(resolve(FIXTURES, "valid-plugin"));
      const filtered = discoverArtifacts(resolve(FIXTURES, "valid-plugin"), {
        ignore: ["*.md"],
      });
      // Should have fewer artifacts (CLAUDE.md, SKILL.md, agent .md, command .md removed)
      expect(filtered.length).toBeLessThan(all.length);
      expect(filtered.every((a) => !a.filePath.endsWith(".md"))).toBe(true);
    });

    it("ignores specific file by name", () => {
      const filtered = discoverArtifacts(resolve(FIXTURES, "valid-plugin"), {
        ignore: ["hooks.json"],
      });
      expect(filtered.every((a) => a.artifactType !== "hooks-json")).toBe(true);
    });

    it("returns all artifacts when no ignore patterns", () => {
      const all = discoverArtifacts(resolve(FIXTURES, "valid-plugin"));
      const withEmpty = discoverArtifacts(resolve(FIXTURES, "valid-plugin"), { ignore: [] });
      expect(all.length).toBe(withEmpty.length);
    });
  });
});
