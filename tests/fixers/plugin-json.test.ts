import { describe, it, expect } from "vitest";
import { pluginJsonFixer } from "../../src/fixers/plugin-json.js";

const CONFIG = { rules: {} };

function fix(content: string) {
  return pluginJsonFixer.fix("plugin.json", content, CONFIG);
}

describe("plugin-json fixer", () => {
  it("sorts keys in canonical order", () => {
    const input = JSON.stringify({ keywords: [], name: "test", version: "1.0.0", description: "A test" });
    const result = JSON.parse(fix(input));
    const keys = Object.keys(result);
    expect(keys[0]).toBe("name");
    expect(keys[1]).toBe("version");
    expect(keys[2]).toBe("description");
    expect(keys[3]).toBe("keywords");
  });

  it("uses tab indentation", () => {
    const input = JSON.stringify({ name: "test" });
    const result = fix(input);
    expect(result).toContain("\t");
  });

  it("adds trailing newline", () => {
    const input = JSON.stringify({ name: "test" });
    const result = fix(input);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("returns invalid JSON unchanged", () => {
    const input = "{bad json";
    expect(fix(input)).toBe(input);
  });

  it("puts unknown keys after canonical keys alphabetically", () => {
    const input = JSON.stringify({ zebra: 1, name: "test", alpha: 2 });
    const result = JSON.parse(fix(input));
    const keys = Object.keys(result);
    expect(keys[0]).toBe("name");
    expect(keys[1]).toBe("alpha");
    expect(keys[2]).toBe("zebra");
  });
});
