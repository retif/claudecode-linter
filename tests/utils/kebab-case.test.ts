import { describe, it, expect } from "vitest";
import { isKebabCase, toKebabCase } from "../../src/utils/kebab-case.js";

describe("isKebabCase", () => {
  it("accepts valid kebab-case", () => {
    expect(isKebabCase("my-plugin")).toBe(true);
  });

  it("accepts a single word", () => {
    expect(isKebabCase("plugin")).toBe(true);
  });

  it("accepts kebab-case with numbers", () => {
    expect(isKebabCase("plugin-v2")).toBe(true);
  });

  it("rejects camelCase", () => {
    expect(isKebabCase("myPlugin")).toBe(false);
  });

  it("rejects underscores", () => {
    expect(isKebabCase("my_plugin")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(isKebabCase("My-Plugin")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isKebabCase("")).toBe(false);
  });
});

describe("toKebabCase", () => {
  it("converts camelCase", () => {
    expect(toKebabCase("myPlugin")).toBe("my-plugin");
  });

  it("converts underscores", () => {
    expect(toKebabCase("my_plugin")).toBe("my-plugin");
  });

  it("converts uppercase", () => {
    expect(toKebabCase("My-Plugin")).toBe("my-plugin");
  });

  it("keeps valid kebab-case unchanged", () => {
    expect(toKebabCase("my-plugin")).toBe("my-plugin");
  });

  it("keeps single word lowercase", () => {
    expect(toKebabCase("Plugin")).toBe("plugin");
  });

  it("handles strings with numbers", () => {
    expect(toKebabCase("pluginV2")).toBe("plugin-v2");
  });

  it("returns empty string for empty input", () => {
    expect(toKebabCase("")).toBe("");
  });
});
