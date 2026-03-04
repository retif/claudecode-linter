import { describe, it, expect } from "vitest";
import { hooksJsonFixer } from "../../src/fixers/hooks-json.js";

const CONFIG = { rules: {} };

function fix(content: string) {
  return hooksJsonFixer.fix("hooks.json", content, CONFIG);
}

describe("hooks-json fixer", () => {
  it("sorts top-level keys alphabetically", () => {
    const input = JSON.stringify({ PreToolUse: [], PostToolUse: [], Notification: [] });
    const result = JSON.parse(fix(input));
    const keys = Object.keys(result);
    expect(keys).toEqual(["Notification", "PostToolUse", "PreToolUse"]);
  });

  it("adds trailing newline", () => {
    const input = JSON.stringify({ hooks: {} });
    expect(fix(input).endsWith("\n")).toBe(true);
  });

  it("uses 2-space indent", () => {
    const input = JSON.stringify({ hooks: {} });
    expect(fix(input)).toContain("  ");
    expect(fix(input)).not.toContain("\t");
  });

  it("returns invalid JSON unchanged", () => {
    expect(fix("{bad")).toBe("{bad");
  });
});
