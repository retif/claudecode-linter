import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mcpJsonLinter } from "../../src/linters/mcp-json.js";
import type { LinterConfig } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const CONFIG: LinterConfig = { rules: {} };

function lint(content: string) {
  return mcpJsonLinter.lint("test.json", content, CONFIG);
}

function lintFile(path: string) {
  return mcpJsonLinter.lint(path, readFileSync(path, "utf-8"), CONFIG);
}

describe("mcp-json linter", () => {
  it("passes for valid mcp.json", () => {
    const diags = lintFile(resolve(FIXTURES, "valid-plugin/.mcp.json"));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("reports invalid JSON", () => {
    const diags = lint("{bad json");
    expect(diags.some((d) => d.rule === "mcp-json/valid-json")).toBe(true);
  });

  it("reports missing mcpServers", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/missing-servers.json"));
    expect(diags.some((d) => d.rule === "mcp-json/servers-required")).toBe(true);
  });

  it("reports server missing transport", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/server-transport")).toBe(true);
  });

  it("reports invalid URL", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/url-valid")).toBe(true);
  });

  // gitea#23: Claude Code expands `${...}` substitutions in .mcp.json before
  // starting a server, so a templated url is not a URL at lint time.
  describe("templated urls (gitea#23)", () => {
    const urlServer = (url: string) => JSON.stringify({
      mcpServers: { "my-server": { type: "streamable-http", url } },
    });

    it.each([
      ["${user_config.browser_mcp_url}", "a user_config substitution"],
      ["${CLAUDE_PLUGIN_ROOT}", "a plugin-root substitution"],
      ["${MCP_URL:-https://example.com}", "an env substitution with a default"],
      ["https://${user_config.host}/mcp", "a partial substitution"],
    ])("does not report url-valid for %s (%s)", (url) => {
      const diags = lint(urlServer(url));
      expect(diags.some((d) => d.rule === "mcp-json/url-valid")).toBe(false);
      expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
    });

    it("still reports url-valid for a genuinely malformed url", () => {
      const diags = lint(urlServer("not a url at all"));
      expect(diags.some((d) => d.rule === "mcp-json/url-valid")).toBe(true);
    });

    it("still reports url-valid when the substitution is only in another field", () => {
      const diags = lint(JSON.stringify({
        mcpServers: {
          "my-server": {
            type: "streamable-http",
            url: "not a url at all",
            headers: { Authorization: "${user_config.token}" },
          },
        },
      }));
      expect(diags.some((d) => d.rule === "mcp-json/url-valid")).toBe(true);
    });

    // The fix suppresses only the unparseable case; a templated url that DOES
    // parse keeps its protocol check, so this is not a blanket skip.
    it("still checks the protocol of a partially templated url", () => {
      const diags = lint(urlServer("ftp://${user_config.host}/mcp"));
      expect(diags.some((d) => d.rule === "mcp-json/url-protocol")).toBe(true);
    });
  });

  it("reports non-kebab-case server name", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/server-name-kebab")).toBe(true);
  });

  it("reports type mismatch with transport", () => {
    const diags = lintFile(resolve(FIXTURES, "invalid/mcp-json/bad-server.json"));
    expect(diags.some((d) => d.rule === "mcp-json/type-matches-transport")).toBe(true);
  });

  it("reports unknown root fields", () => {
    const diags = lint(JSON.stringify({
      mcpServers: { "test-server": { command: "cmd" } },
      extraField: true,
    }));
    expect(diags.some((d) => d.rule === "mcp-json/no-unknown-root-fields")).toBe(true);
  });

  it("reports args not array", () => {
    const diags = lint(JSON.stringify({
      mcpServers: { test: { command: "cmd", args: "not-array" } },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/args-array")).toBe(true);
  });

  it("reports env not object", () => {
    const diags = lint(JSON.stringify({
      mcpServers: { test: { command: "cmd", env: "bad" } },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/env-object")).toBe(true);
  });

  it("accepts valid http server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "http", url: "https://example.com/mcp" },
      },
    }));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("accepts streamable-http type on a URL server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "streamable-http", url: "https://example.com/mcp" },
      },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/type-matches-transport")).toBe(false);
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("still flags a bogus type on a URL server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "stdio", url: "https://example.com/mcp" },
      },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/type-matches-transport")).toBe(true);
  });

  it("accepts valid stdio server", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "local-server": { command: "/usr/bin/mcp", args: ["--port", "3000"] },
      },
    }));
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("warns on type:http for URL-based server (prefer-streamable-http)", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "http", url: "https://example.com/mcp" },
      },
    }));
    const d = diags.find((d) => d.rule === "mcp-json/prefer-streamable-http");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
  });

  it("does not warn prefer-streamable-http on streamable-http URL servers", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "my-server": { type: "streamable-http", url: "https://example.com/mcp" },
      },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/prefer-streamable-http")).toBe(false);
  });

  it("does not warn prefer-streamable-http on stdio servers", () => {
    const diags = lint(JSON.stringify({
      mcpServers: {
        "local": { command: "/usr/bin/mcp" },
      },
    }));
    expect(diags.some((d) => d.rule === "mcp-json/prefer-streamable-http")).toBe(false);
  });

  it("warns .mcp.json at user level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint(".mcp.json", content, CONFIG, "user");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(true);
  });

  it("warns mcp.json at project level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint("mcp.json", content, CONFIG, "project");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(true);
  });

  it("accepts mcp.json at user level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint("mcp.json", content, CONFIG, "user");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(false);
  });

  it("accepts .mcp.json at project level", () => {
    const content = JSON.stringify({ mcpServers: { test: { command: "cmd" } } });
    const diags = mcpJsonLinter.lint(".mcp.json", content, CONFIG, "project");
    expect(diags.some((d) => d.rule === "mcp-json/scope-file-name")).toBe(false);
  });

  describe("schema-valid", () => {
    it("does not flag a valid .mcp.json", () => {
      const diags = lintFile(resolve(FIXTURES, "valid-plugin/.mcp.json"));
      expect(diags.some((d) => d.rule === "mcp-json/schema-valid")).toBe(false);
    });

    it("flags a malformed server field type", () => {
      const diags = lintFile(
        resolve(FIXTURES, "invalid/mcp-json/bad-schema-types.json"),
      );
      const schemaErrors = diags.filter(
        (d) => d.rule === "mcp-json/schema-valid",
      );
      expect(schemaErrors.length).toBeGreaterThan(0);
      expect(schemaErrors.every((d) => d.severity === "error")).toBe(true);
    });

    it("respects the rule being disabled", () => {
      const diags = mcpJsonLinter.lint(
        ".mcp.json",
        readFileSync(
          resolve(FIXTURES, "invalid/mcp-json/bad-schema-types.json"),
          "utf-8",
        ),
        { rules: { "mcp-json/schema-valid": false } },
      );
      expect(diags.some((d) => d.rule === "mcp-json/schema-valid")).toBe(false);
    });

    // Per-branch coverage of the `mcpServers` transport union in
    // contracts/mcp.schema.json. The union has 8 branches: stdio, sse,
    // sse-ide, ws-ide, http (type enum ["http","streamable-http"]), ws, sdk,
    // claudeai-proxy. Each is structurally typed (const/enum `type` discriminator
    // plus typed required fields) — none are hollow placeholders, so every
    // branch gets both a valid-passes and a malformed-errors test.

    function schemaErrors(content: string) {
      return lint(content).filter((d) => d.rule === "mcp-json/schema-valid");
    }
    const mcp = (server: unknown) =>
      JSON.stringify({ mcpServers: { srv: server } });

    describe("transport union branches", () => {
      // --- stdio ---
      it("stdio: minimal valid config produces no schema-valid error", () => {
        expect(schemaErrors(mcp({ command: "/usr/bin/mcp" }))).toHaveLength(0);
      });
      it("stdio: command of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "stdio", command: 12345 })).length,
        ).toBeGreaterThan(0);
      });
      it("stdio: missing required command produces a schema-valid error", () => {
        expect(schemaErrors(mcp({ type: "stdio" })).length).toBeGreaterThan(0);
      });

      // --- sse ---
      it("sse: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "sse", url: "https://example.com/sse" })),
        ).toHaveLength(0);
      });
      it("sse: url of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "sse", url: 123 })).length,
        ).toBeGreaterThan(0);
      });
      it("sse: missing required url produces a schema-valid error", () => {
        expect(schemaErrors(mcp({ type: "sse" })).length).toBeGreaterThan(0);
      });

      // --- sse-ide ---
      it("sse-ide: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors(
            mcp({
              type: "sse-ide",
              url: "https://example.com/sse",
              ideName: "VSCode",
            }),
          ),
        ).toHaveLength(0);
      });
      it("sse-ide: ideName of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(
            mcp({ type: "sse-ide", url: "https://example.com/sse", ideName: 5 }),
          ).length,
        ).toBeGreaterThan(0);
      });
      it("sse-ide: missing required ideName produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "sse-ide", url: "https://example.com/sse" }))
            .length,
        ).toBeGreaterThan(0);
      });

      // --- ws-ide ---
      it("ws-ide: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors(
            mcp({
              type: "ws-ide",
              url: "wss://example.com/ws",
              ideName: "VSCode",
            }),
          ),
        ).toHaveLength(0);
      });
      it("ws-ide: ideName of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(
            mcp({ type: "ws-ide", url: "wss://example.com/ws", ideName: 5 }),
          ).length,
        ).toBeGreaterThan(0);
      });
      it("ws-ide: missing required ideName produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "ws-ide", url: "wss://example.com/ws" }))
            .length,
        ).toBeGreaterThan(0);
      });

      // --- http (type enum ["http","streamable-http"]) ---
      it("http: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "http", url: "https://example.com/mcp" })),
        ).toHaveLength(0);
      });
      it("http: type \"streamable-http\" is accepted by the http branch", () => {
        expect(
          schemaErrors(
            mcp({ type: "streamable-http", url: "https://example.com/mcp" }),
          ),
        ).toHaveLength(0);
      });
      it("http: url of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "http", url: 123 })).length,
        ).toBeGreaterThan(0);
      });
      it("http: missing required url produces a schema-valid error", () => {
        expect(schemaErrors(mcp({ type: "http" })).length).toBeGreaterThan(0);
      });

      // --- ws ---
      it("ws: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "ws", url: "wss://example.com/ws" })),
        ).toHaveLength(0);
      });
      it("ws: url of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "ws", url: 123 })).length,
        ).toBeGreaterThan(0);
      });
      it("ws: missing required url produces a schema-valid error", () => {
        expect(schemaErrors(mcp({ type: "ws" })).length).toBeGreaterThan(0);
      });

      // --- sdk ---
      it("sdk: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "sdk", name: "my-sdk-server" })),
        ).toHaveLength(0);
      });
      it("sdk: name of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "sdk", name: 5 })).length,
        ).toBeGreaterThan(0);
      });
      it("sdk: missing required name produces a schema-valid error", () => {
        expect(schemaErrors(mcp({ type: "sdk" })).length).toBeGreaterThan(0);
      });

      // --- claudeai-proxy ---
      it("claudeai-proxy: minimal valid config produces no schema-valid error", () => {
        expect(
          schemaErrors(
            mcp({
              type: "claudeai-proxy",
              url: "https://example.com",
              id: "proxy-1",
            }),
          ),
        ).toHaveLength(0);
      });
      it("claudeai-proxy: id of wrong type produces a schema-valid error", () => {
        expect(
          schemaErrors(
            mcp({ type: "claudeai-proxy", url: "https://example.com", id: 5 }),
          ).length,
        ).toBeGreaterThan(0);
      });
      it("claudeai-proxy: missing required id produces a schema-valid error", () => {
        expect(
          schemaErrors(mcp({ type: "claudeai-proxy", url: "https://example.com" }))
            .length,
        ).toBeGreaterThan(0);
      });
    });
  });
});
