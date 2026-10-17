import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentMdLinter } from "../../src/linters/agent-md.js";
import { claudeMdLinter } from "../../src/linters/claude-md.js";
import { hooksJsonLinter } from "../../src/linters/hooks-json.js";
import { pluginJsonLinter } from "../../src/linters/plugin-json.js";
import { settingsJsonLinter } from "../../src/linters/settings-json.js";
import { skillMdLinter } from "../../src/linters/skill-md.js";
import type { Linter, LinterConfig } from "../../src/types.js";

// oleks/claudecode-linter#51 — references between files.
const FIXTURES = resolve(import.meta.dirname, "../fixtures/cross-file");
const CONFIG: LinterConfig = { rules: {} };

function lint(linter: Linter, rel: string, rule: string) {
  const path = resolve(FIXTURES, rel);
  return linter.lint(path, readFileSync(path, "utf-8"), CONFIG, "project").filter((d) => d.rule === rule);
}

describe("hooks-json/script-exists", () => {
  const diags = () => lint(hooksJsonLinter, "plugin/hooks/hooks.json", "hooks-json/script-exists");

  it("reports ${CLAUDE_PLUGIN_ROOT} and $CLAUDE_PLUGIN_ROOT scripts that are missing", () => {
    const msgs = diags().map((d) => d.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh");
    expect(msgs[1]).toContain("$CLAUDE_PLUGIN_ROOT/scripts/also-missing.js");
  });

  it("accepts present scripts, directories, unresolvable vars and unknown project dirs", () => {
    const msgs = diags().map((d) => d.message).join("\n");
    expect(msgs).not.toContain("present.sh");
    expect(msgs).not.toContain("$HOOK_NAME");
    expect(msgs).not.toContain("CLAUDE_PROJECT_DIR");
  });

  it("can be disabled", () => {
    const path = resolve(FIXTURES, "plugin/hooks/hooks.json");
    const diags = hooksJsonLinter.lint(path, readFileSync(path, "utf-8"),
      { rules: { "hooks-json/script-exists": false } });
    expect(diags.some((d) => d.rule === "hooks-json/script-exists")).toBe(false);
  });
});

describe("settings-json/hook-script-exists", () => {
  it("resolves ${CLAUDE_PROJECT_DIR} against the project of .claude/settings.json", () => {
    const diags = lint(settingsJsonLinter, "project/.claude/settings.json", "settings-json/hook-script-exists");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(".claude/hooks/missing.sh");
    // ${CLAUDE_PLUGIN_ROOT} has no meaning in a project's settings — skipped.
    expect(diags[0].message).not.toContain("not-a-plugin.sh");
  });
});

describe("claude-md imports", () => {
  const all = () => {
    const path = resolve(FIXTURES, "project/CLAUDE.md");
    return claudeMdLinter.lint(path, readFileSync(path, "utf-8"), CONFIG, "project");
  };

  it("import-resolves reports missing files and directories, following nested imports", () => {
    const diags = all().filter((d) => d.rule === "claude-md/import-resolves");
    const msgs = diags.map((d) => d.message);
    expect(msgs).toHaveLength(3);
    expect(msgs.some((m) => m.includes("@docs/missing.md"))).toBe(true);
    expect(msgs.some((m) => m.includes("@docs\"") && m.includes("directory"))).toBe(true);
    // Nested: reported at the root file's top-level import, with the chain.
    const nested = diags.find((d) => d.message.includes("@./gone.md"));
    expect(nested?.message).toContain("via @docs/a.md → @nested/b.md");
    expect(nested?.line).toBe(7);
  });

  it("import-resolves ignores code spans, fences, HTML comments, mentions and package names", () => {
    const msgs = all().map((d) => d.message).join("\n");
    for (const s of ["span-missing", "fence-missing", "comment-missing", "@oleks", "anthropic-ai", "missing-mail"]) {
      expect(msgs).not.toContain(s);
    }
    // `#fragment` is stripped before resolving.
    expect(msgs).not.toContain("a.md#intro");
  });

  it("import-circular reports a cycle back onto the import stack", () => {
    const diags = all().filter((d) => d.rule === "claude-md/import-circular");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("leads back to docs/cycle-a.md");
    expect(diags[0].line).toBe(9);
  });

  it("import-depth reports the fifth hop, which Claude Code drops", () => {
    const diags = all().filter((d) => d.rule === "claude-md/import-depth");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("@deep5.md");
    expect(diags[0].message).toContain("5 hops deep");
  });

  it("allows four nested hops", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccl-depth-"));
    try {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, "d1.md"), "@d2.md\n");
      writeFileSync(join(dir, "d2.md"), "@d3.md\n");
      writeFileSync(join(dir, "d3.md"), "@d4.md\n");
      writeFileSync(join(dir, "d4.md"), "# end\n");
      const content = "# P\n\n## S\n\n@d1.md\n";
      const diags = claudeMdLinter.lint(join(dir, "CLAUDE.md"), content, CONFIG);
      expect(diags.filter((d) => d.rule.startsWith("claude-md/import-"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("an empty CLAUDE.md without imports reports nothing", () => {
    const diags = claudeMdLinter.lint("/nonexistent/CLAUDE.md", "# T\n\n## S\n\nNo imports here.\n", CONFIG);
    expect(diags.filter((d) => d.rule.startsWith("claude-md/import-"))).toHaveLength(0);
  });

  describe("stays inside the project root", () => {
    let outside: string;
    let project: string;
    beforeAll(() => {
      outside = mkdtempSync(join(tmpdir(), "ccl-outside-"));
      project = mkdtempSync(join(tmpdir(), "ccl-project-"));
      mkdirSync(join(project, ".claude"));
      // Outside the root: imports a missing file. If the linter read it, it
      // would report that nested miss.
      writeFileSync(join(outside, "external.md"), "@definitely-missing.md\n");
    });
    afterAll(() => {
      rmSync(outside, { recursive: true });
      rmSync(project, { recursive: true });
    });

    it("existence-checks an absolute import outside the root but does not read it", () => {
      const content = `# P\n\n## S\n\n@${join(outside, "external.md")}\n`;
      const diags = claudeMdLinter.lint(join(project, "CLAUDE.md"), content, CONFIG);
      expect(diags.filter((d) => d.rule.startsWith("claude-md/import-"))).toHaveLength(0);
    });

    it("still reports a missing absolute import", () => {
      const content = `# P\n\n## S\n\n@${join(outside, "nope.md")}\n`;
      const diags = claudeMdLinter.lint(join(project, "CLAUDE.md"), content, CONFIG);
      expect(diags.filter((d) => d.rule === "claude-md/import-resolves")).toHaveLength(1);
    });
  });
});

describe("agent-md/skills-exist", () => {
  it("accepts own-plugin skills by dir name, frontmatter name, qualified name, commands and other plugins", () => {
    expect(lint(agentMdLinter, "plugin/agents/good.md", "agent-md/skills-exist")).toHaveLength(0);
  });

  it("reports unknown bare and own-plugin-qualified skills", () => {
    const diags = lint(agentMdLinter, "plugin/agents/bad.md", "agent-md/skills-exist");
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining("\"missing-skill-xref-fixture\""),
      expect.stringContaining("\"xref-plugin:nope\" is not provided by plugin \"xref-plugin\""),
    ]);
    expect(diags[0].line).toBe(5);
  });
});

describe("plugin-json/component-paths-exist", () => {
  it("reports declared component paths that are missing", () => {
    const diags = lint(pluginJsonLinter, "plugin/.claude-plugin/plugin.json", "plugin-json/component-paths-exist");
    const msgs = diags.map((d) => d.message);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toContain("\"commands\" path \"./commands/missing.md\"");
    expect(msgs[1]).toContain("\"hooks\" path \"./hooks/extra-hooks.json\"");
    expect(msgs[2]).toContain("\"outputStyles\" path \"./output-styles\"");
  });

  it("skips URLs and inline objects", () => {
    const msgs = lint(pluginJsonLinter, "plugin/.claude-plugin/plugin.json", "plugin-json/component-paths-exist")
      .map((d) => d.message).join("\n");
    expect(msgs).not.toContain("monitors");
    expect(msgs).not.toContain("lspServers");
  });
});

describe("skill-md/referenced-files-exist", () => {
  it("reports broken relative links and images with their file line", () => {
    const diags = lint(skillMdLinter, "plugin/skills/helper/SKILL.md", "skill-md/referenced-files-exist");
    expect(diags.map((d) => [d.line, d.message.split(" does")[0]])).toEqual([
      [12, "Link target \"./assets/missing.png\""],
      [13, "Link target \"references/missing.md\""],
    ]);
  });
});
