import { describe, it, expect } from "vitest";
import { resolve, relative, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";

// Test classifyFile indirectly through discoverArtifacts with single file
import { discoverArtifacts, detectArtifactTypes } from "../src/discovery.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

/** Create `<dir>/.claude/settings.json`, making every parent as needed. */
function writeClaudeSettings(dir: string): string {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const file = join(dir, ".claude", "settings.json");
  writeFileSync(file, "{}\n");
  return file;
}

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

describe("detectArtifactTypes", () => {
  it("returns the distinct artifact types of a plugin, sorted", () => {
    const types = detectArtifactTypes([resolve(FIXTURES, "valid-plugin")]);
    expect(types).toContain("plugin-json");
    expect(types).toContain("skill-md");
    expect([...types]).toEqual([...types].sort());
    expect(types).not.toContain("misplaced-file");
  });

  it("returns [] when the path holds no Claude Code artifacts", () => {
    const here = resolve(import.meta.dirname, "discovery.test.ts");
    expect(detectArtifactTypes([here])).toEqual([]);
  });
});

describe("project-local artifacts under .claude/", () => {
  const PROJECT_LOCAL = resolve(FIXTURES, "invalid/project-local");

  it("discovers .claude/skills/<name>/SKILL.md as skill-md with project scope", () => {
    const artifacts = discoverArtifacts(PROJECT_LOCAL);
    const skill = artifacts.find((a) => a.artifactType === "skill-md");
    expect(skill).toBeDefined();
    expect(relative(PROJECT_LOCAL, skill!.filePath)).toBe(
      ".claude/skills/Bad Skill Name/SKILL.md",
    );
    expect(skill!.scope).toBe("project");
  });

  it("discovers .claude/commands/<name>.md as command-md with project scope", () => {
    const artifacts = discoverArtifacts(PROJECT_LOCAL);
    const command = artifacts.find((a) => a.artifactType === "command-md");
    expect(command).toBeDefined();
    expect(relative(PROJECT_LOCAL, command!.filePath)).toBe(
      ".claude/commands/bad-tools.md",
    );
    expect(command!.scope).toBe("project");
  });

  it("scopes a project-local skill as project, like the .claude/ artifacts beside it", () => {
    // The acceptance bar from oleks/claudecode-linter#32: a project-local
    // skill must not report a different scope from the other project-local
    // artifacts discovered next to it.
    // Compare fixture-relative paths: the repo's own worktrees live under
    // `.claude/worktrees/`, so an absolute path always contains "/.claude/".
    const root = resolve(FIXTURES, "valid-plugin");
    const projectLocalSkill = discoverArtifacts(root).find(
      (a) =>
        a.artifactType === "skill-md" &&
        relative(root, a.filePath) ===
          ".claude/skills/project-local-helper/SKILL.md",
    );
    expect(projectLocalSkill?.scope).toBe("project");
  });

  it("leaves the plugin's own skills/ unscoped", () => {
    const root = resolve(FIXTURES, "valid-plugin");
    const artifacts = discoverArtifacts(root);
    const pluginSkill = artifacts.find(
      (a) =>
        a.artifactType === "skill-md" &&
        relative(root, a.filePath) === "skills/example-skill/SKILL.md",
    );
    expect(pluginSkill).toBeDefined();
    // A plugin skill ships to every install — it has no project scope, and
    // must not acquire one just because some ancestor directory happens to
    // be named `.claude/` (e.g. a `.claude/worktrees/` checkout).
    expect(pluginSkill!.scope).toBeUndefined();
  });

  it("does not discover .claude/skills/SKILL.md (no <name> directory)", () => {
    // Claude Code reads nothing from that path; misplaced-file owns it.
    const root = resolve(FIXTURES, "invalid/misplaced-file");
    const skills = discoverArtifacts(root).filter(
      (a) => a.artifactType === "skill-md",
    );
    expect(
      skills.some(
        (a) => relative(root, a.filePath) === ".claude/skills/SKILL.md",
      ),
    ).toBe(false);
  });

  it("reports project-local artifact types via detectArtifactTypes", () => {
    const types = detectArtifactTypes([PROJECT_LOCAL]);
    expect(types).toEqual(["command-md", "skill-md"]);
  });
});

describe("scope is anchored on what was scanned, not on ancestors (#36)", () => {
  // oleks/claudecode-linter#36: scope used to be decided by walking up from the
  // artifact until *any* ancestor `.claude/` was found. That made the answer
  // depend on directories nobody asked about — this repo's own untracked
  // `.claude/` re-scoped every fixture beneath it, and `~/.claude` re-scoped
  // every real project under $HOME. These pin that dependency out.

  function withTree<T>(base: string, fn: (root: string) => T): T {
    const root = mkdtempSync(join(base, "ccl36-scope-"));
    try {
      return fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("scopes a scanned root's .claude/ as project though an ancestor has one", () => {
    withTree(tmpdir(), (root) => {
      writeClaudeSettings(root); // the ancestor's own .claude/
      const inner = join(root, "inner");
      mkdirSync(inner);
      writeClaudeSettings(inner);

      const settings = discoverArtifacts(inner).find(
        (a) => a.artifactType === "settings-json",
      );
      expect(settings).toBeDefined();
      expect(settings!.scope).toBe("project");
    });
  });

  it("scopes an identical tree identically wherever it is checked out", () => {
    // The equivalence #36 is really about: the same tree must not scope
    // differently because of what happens to sit above it on disk.
    const scopeUnder = (base: string) =>
      withTree(base, (root) => {
        const proj = join(root, "proj");
        mkdirSync(proj);
        writeClaudeSettings(proj);
        return discoverArtifacts(proj).find(
          (a) => a.artifactType === "settings-json",
        )?.scope;
      });

    // $HOME has `~/.claude` above it; the OS temp dir does not.
    expect(scopeUnder(homedir())).toBe("project");
    expect(scopeUnder(homedir())).toBe(scopeUnder(tmpdir()));
  });

  it("does not treat ~/.claude as a project containing everything below it", () => {
    // Exercised only where the user config dir actually exists; where it does
    // not there is no ancestor to be fooled by and the check is vacuous.
    if (!existsSync(join(homedir(), ".claude"))) return;
    withTree(homedir(), (root) => {
      const proj = join(root, "proj");
      mkdirSync(proj);
      const file = writeClaudeSettings(proj);

      // Named directly, so there is no scan root to fall back on and the
      // upward walk — the part `~/.claude` used to poison — decides.
      const artifacts = discoverArtifacts(file);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].scope).toBe("project");
    });
  });

  it("still reports subdirectory for a .claude/ nested under a project's own", () => {
    // `subdirectory` must stay reachable: narrowing the walk is meant to stop
    // false positives, not to delete the distinction.
    withTree(tmpdir(), (root) => {
      writeClaudeSettings(root); // the containing project's .claude/
      const nested = join(root, "sub");
      mkdirSync(nested);
      const file = writeClaudeSettings(nested);

      const artifacts = discoverArtifacts(file);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].scope).toBe("subdirectory");
    });
  });
});
