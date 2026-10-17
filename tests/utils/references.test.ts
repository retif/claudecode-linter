import { describe, it, expect } from "vitest";
import {
  extractImports,
  extractLocalLinks,
  hookScriptRefs,
  isInside,
  proseOnly,
} from "../../src/utils/references.js";

describe("hookScriptRefs", () => {
  const roots = { plugin: "/p", project: "/proj" };
  const paths = (cmd: string, r: { plugin?: string | null; project?: string | null } = roots) =>
    hookScriptRefs(cmd, r).map((x) => x.resolved);

  it("finds root-variable words anywhere in the command", () => {
    expect(paths("${CLAUDE_PLUGIN_ROOT}/a.sh")).toEqual(["/p/a.sh"]);
    expect(paths("bash \"${CLAUDE_PLUGIN_ROOT}/b c.sh\" x")).toEqual(["/p/b c.sh"]);
    expect(paths("\"$CLAUDE_PROJECT_DIR\"/h.sh && $CLAUDE_PLUGIN_ROOT/x")).toEqual(["/proj/h.sh", "/p/x"]);
    expect(paths("tool --config=${CLAUDE_PLUGIN_ROOT}/c.json")).toEqual(["/p/c.json"]);
  });

  it("skips unknown roots, other vars, globs and non-root paths", () => {
    expect(paths("${CLAUDE_PROJECT_DIR}/x", { plugin: "/p" })).toEqual([]);
    expect(paths("${CLAUDE_PLUGIN_ROOT}/$NAME.sh")).toEqual([]);
    expect(paths("${CLAUDE_PLUGIN_ROOT}/*.sh")).toEqual([]);
    expect(paths("${CLAUDE_PLUGIN_DATA}/x ./rel.sh /abs.sh")).toEqual([]);
    expect(paths("$CLAUDE_PLUGIN_ROOTX/a")).toEqual([]);
  });
});

describe("proseOnly", () => {
  it("blanks fences, code spans and HTML comments, keeping columns", () => {
    const out = proseOnly("a `@x` b\n```\n@y\n```\n<!-- @z\n@w -->c @v");
    expect(out[0]).toBe(`a ${" ".repeat(4)} b`);
    expect(out[2]).toBe("");
    expect(out.join("\n")).not.toMatch(/@[xyzw]/);
    expect(out[5]).toContain("c @v");
  });

  it("closes a fence only on the same marker of at least the same length", () => {
    const out = proseOnly("````\n```\n@in\n````\n@out");
    expect(out.join("\n")).not.toContain("@in");
    expect(out[4]).toBe("@out");
  });
});

describe("extractImports", () => {
  const paths = (s: string) => extractImports(s).map((i) => i.path);

  it("matches Claude Code's accepted forms", () => {
    expect(paths("@a.md @./b.md @~/c.md @/d.md")).toEqual(["a.md", "./b.md", "~/c.md", "/d.md"]);
    expect(paths("x @with\\ space.md")).toEqual(["with space.md"]);
    expect(paths("@frag.md#sec")).toEqual(["frag.md"]);
  });

  it("rejects what the runtime rejects", () => {
    expect(paths("mail@x.md @/ @@scope @#tag @(x)")).toEqual([]);
  });

  it("reports 1-based line and the @ column", () => {
    expect(extractImports("intro\n  - @a.md")).toEqual([{ path: "a.md", line: 2, column: 5 }]);
  });
});

describe("extractLocalLinks", () => {
  const targets = (s: string) => extractLocalLinks(s).map((l) => l.target);

  it("returns relative targets with anchors, queries and escapes handled", () => {
    expect(targets("[a](x.md) ![i](./img.png \"t\") [b](<sp ace.md>) [c](y.md#h) [d](z%20q.md?v=1)"))
      .toEqual(["x.md", "./img.png", "sp ace.md", "y.md", "z q.md"]);
  });

  it("drops URLs, anchors, absolute, home and variable paths", () => {
    expect(targets("[a](https://x) [b](#h) [c](/abs) [d](~/h) [e](${V}/x) [f](mailto:a@b)")).toEqual([]);
  });
});

describe("isInside", () => {
  it("bounds by path segments, not string prefix", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b/../x")).toBe(false);
  });
});
