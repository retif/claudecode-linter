import { describe, it, expect } from "vitest";
import { frontmatterFixer } from "../../src/fixers/frontmatter.js";

const CONFIG = { rules: {} };

function fix(content: string) {
  return frontmatterFixer.fix("SKILL.md", content, CONFIG);
}

describe("frontmatter fixer", () => {
  it("normalizes name to kebab-case", () => {
    const input = "---\nname: My Skill Name\ndescription: A skill\n---\n\nBody text\n";
    const result = fix(input);
    expect(result).toContain("name: my-skill-name");
  });

  it("strips trailing whitespace", () => {
    const input = "---\nname: test  \n---\n\nBody   \n";
    const result = fix(input);
    expect(result).not.toMatch(/[ \t]+$/m);
  });

  it("ensures trailing newline", () => {
    const input = "---\nname: test\n---\n\nBody";
    const result = fix(input);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("leaves already kebab-case names unchanged", () => {
    const input = "---\nname: my-skill\ndescription: desc\n---\n\nBody\n";
    const result = fix(input);
    expect(result).toContain("name: my-skill");
  });

  it("returns content without frontmatter unchanged (except whitespace fixes)", () => {
    const input = "No frontmatter here\n";
    const result = fix(input);
    expect(result).toBe("No frontmatter here\n");
  });
});
