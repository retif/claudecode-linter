import { describe, it, expect } from "vitest";
import { isValidSemver } from "../../src/utils/semver.js";

describe("isValidSemver", () => {
  it("accepts plain versions", () => {
    expect(isValidSemver("0.0.0")).toBe(true);
    expect(isValidSemver("1.2.3")).toBe(true);
    expect(isValidSemver("10.20.30")).toBe(true);
  });

  it("accepts prerelease and build metadata", () => {
    expect(isValidSemver("1.0.0-alpha")).toBe(true);
    expect(isValidSemver("1.0.0-alpha.1")).toBe(true);
    expect(isValidSemver("1.0.0-0.3.7")).toBe(true);
    expect(isValidSemver("1.0.0+build.1")).toBe(true);
    expect(isValidSemver("1.0.0-beta+exp.sha.5114f85")).toBe(true);
  });

  it("tolerates a leading v and surrounding whitespace", () => {
    expect(isValidSemver("v1.2.3")).toBe(true);
    expect(isValidSemver("  1.2.3  ")).toBe(true);
    expect(isValidSemver(" v1.2.3 ")).toBe(true);
  });

  it("rejects malformed versions", () => {
    expect(isValidSemver("")).toBe(false);
    expect(isValidSemver("1")).toBe(false);
    expect(isValidSemver("1.2")).toBe(false);
    expect(isValidSemver("1.2.3.4")).toBe(false);
    expect(isValidSemver("01.2.3")).toBe(false);
    expect(isValidSemver("1.2.3-")).toBe(false);
    expect(isValidSemver("1.2.3+")).toBe(false);
    expect(isValidSemver("^1.2.3")).toBe(false);
    expect(isValidSemver("1.2.x")).toBe(false);
    expect(isValidSemver("latest")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidSemver(undefined)).toBe(false);
    expect(isValidSemver(null)).toBe(false);
    expect(isValidSemver(123)).toBe(false);
  });

  it("rejects out-of-range numeric components", () => {
    expect(isValidSemver("9007199254740993.0.0")).toBe(false);
  });
});
