import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { settingsJsonLinter, SETTINGS_JSON_RULES } from "../src/linters/settings-json.js";
import {
  PERMISSIONS_FIELDS,
  SANDBOX_FIELDS,
  PERMISSION_MODES,
  SANDBOX_NETWORK_FIELDS,
  SANDBOX_FILESYSTEM_FIELDS,
} from "../src/contracts.js";
import type { LinterConfig, ConfigScope, LintDiagnostic } from "../src/types.js";

const clean: LinterConfig = { rules: {} };

/** Lint an object as a settings file; returns the raw diagnostics. */
function diagnose(
  obj: unknown,
  scope: ConfigScope = "user",
  fileName = "settings.json",
  config: LinterConfig = clean,
): LintDiagnostic[] {
  return settingsJsonLinter.lint(fileName, JSON.stringify(obj, null, 2), config, scope);
}

/** Just the rule ids that fired. */
function rules(obj: unknown, scope: ConfigScope = "user"): string[] {
  return diagnose(obj, scope).map((d) => d.rule);
}

/** The first diagnostic for a given rule, or undefined. */
function find(obj: unknown, rule: string): LintDiagnostic | undefined {
  return diagnose(obj).find((d) => d.rule === rule);
}

// ───────────────────────── permissions (approvals) ─────────────────────────

describe("settings-json permissions — valid input", () => {
  it("accepts a fully-populated permissions block with no diagnostics", () => {
    expect(rules({
      permissions: {
        allow: ["Bash(npm run build:*)", "Read", "Edit(src/**)", "mcp__github__search"],
        deny: ["Bash(rm:*)", "WebFetch"],
        ask: ["Write"],
        defaultMode: "acceptEdits",
        disableBypassPermissionsMode: "disable",
        disableAutoMode: true,
        additionalDirectories: ["../shared"],
      },
    })).toEqual([]);
  });

  it("accepts an empty permissions object", () => {
    expect(rules({ permissions: {} })).toEqual([]);
  });

  it.each([...PERMISSION_MODES])("accepts defaultMode %s", (mode) => {
    expect(rules({ permissions: { defaultMode: mode } })).toEqual([]);
  });

  it("does not warn on mcp__ or scoped tool patterns", () => {
    expect(rules({
      permissions: { allow: ["mcp__a__b", "Bash(ls:*)", "WebFetch(domain:example.com)"] },
    })).toEqual([]);
  });
});

describe("settings-json permissions — structural errors", () => {
  it.each([
    ["string", "nope"],
    ["array", ["allow"]],
    ["null", null],
  ])("flags permissions as a %s", (_label, value) => {
    const d = find({ permissions: value }, "settings-json/permissions-object");
    expect(d?.severity).toBe("error");
  });

  it("flags an unknown permissions sub-key as a warning", () => {
    const d = find({ permissions: { allize: ["Read"] } }, "settings-json/permissions-unknown-field");
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain("permissions.allize");
  });

  it("does not flag any known permissions sub-key as unknown", () => {
    for (const key of PERMISSIONS_FIELDS) {
      const value = key === "defaultMode" ? "default"
        : key === "disableBypassPermissionsMode" ? "disable"
        : key === "disableAutoMode" ? true
        : [];
      expect(rules({ permissions: { [key]: value } }))
        .not.toContain("settings-json/permissions-unknown-field");
    }
  });
});

describe("settings-json permissions — allow / deny / ask rule arrays", () => {
  it.each([
    ["allow", "settings-json/allow-array"],
    ["deny", "settings-json/deny-array"],
    ["ask", "settings-json/ask-array"],
  ])("flags %s when it is not an array", (key, rule) => {
    const d = find({ permissions: { [key]: "Read" } }, rule);
    expect(d?.severity).toBe("error");
  });

  it.each(["allow", "deny", "ask"])("flags a non-string entry in %s", (key) => {
    const d = diagnose({ permissions: { [key]: ["Read", 42] } })
      .find((x) => x.message.includes("must be strings"));
    expect(d?.severity).toBe("error");
  });

  // gitea#21: the extracted registry lags the harness; a well-formed unknown
  // permission target is accepted, a near-miss still reported.
  it("does not warn on built-ins missing from the extracted registry", () => {
    const d = find(
      { permissions: { allow: ["ListAgents", "DesignSync", "SendFeedback", "EndConversation"] } },
      "settings-json/allow-known-tools",
    );
    expect(d).toBeUndefined();
  });

  it.each(["allow", "deny", "ask"])("warns on an unknown tool in %s", (key) => {
    const d = find({ permissions: { [key]: ["Bahs"] } }, "settings-json/allow-known-tools");
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain(`permissions.${key}`);
  });
});

describe("settings-json permissions — defaultMode & disableBypassPermissionsMode", () => {
  it.each([
    ["unknown string", "turbo"],
    ["non-string", true],
  ])("warns on a %s defaultMode", (_label, value) => {
    const d = find({ permissions: { defaultMode: value } }, "settings-json/permissions-default-mode");
    expect(d?.severity).toBe("warning");
  });

  it("accepts disableBypassPermissionsMode: \"disable\"", () => {
    expect(rules({ permissions: { disableBypassPermissionsMode: "disable" } })).toEqual([]);
  });

  it.each([
    ["a different string", "disabled"],
    ["a boolean", true],
  ])("warns when disableBypassPermissionsMode is %s", (_label, value) => {
    const d = find({ permissions: { disableBypassPermissionsMode: value } },
      "settings-json/permissions-disable-bypass");
    expect(d?.severity).toBe("warning");
  });
});

// ──────────────────────────────── sandbox ──────────────────────────────────

describe("settings-json sandbox — valid input", () => {
  it("accepts a fully-populated sandbox block with no diagnostics", () => {
    expect(rules({
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        excludedCommands: ["docker", "podman"],
        network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: [] },
        filesystem: { allowWrite: ["/tmp"], denyRead: ["/etc/shadow"] },
        ignoreViolations: { Bash: ["rule-1"] },
        ripgrep: { command: "rg", args: ["--hidden"] },
        bwrapPath: "/usr/bin/bwrap",
      },
    })).toEqual([]);
  });

  it("accepts an empty sandbox object", () => {
    expect(rules({ sandbox: {} })).toEqual([]);
  });
});

describe("settings-json sandbox — structural errors", () => {
  it.each([
    ["boolean", true],
    ["array", []],
    ["string", "on"],
    ["null", null],
  ])("flags sandbox as a %s", (_label, value) => {
    const d = find({ sandbox: value }, "settings-json/sandbox-object");
    expect(d?.severity).toBe("error");
  });

  it("warns on an unknown sandbox sub-key", () => {
    const d = find({ sandbox: { autoAlowBash: true } }, "settings-json/sandbox-unknown-field");
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain("sandbox.autoAlowBash");
  });
});

describe("settings-json sandbox — per-field type checks", () => {
  // Each known field paired with a value of the WRONG type.
  const wrong: Array<[string, unknown]> = [
    ["enabled", "yes"],
    ["failIfUnavailable", 1],
    ["autoAllowBashIfSandboxed", "true"],
    ["allowUnsandboxedCommands", []],
    ["enableWeakerNestedSandbox", "no"],
    ["enableWeakerNetworkIsolation", 0],
    ["excludedCommands", "docker"],
    ["network", []],
    ["filesystem", "open"],
    ["ripgrep", true],
    ["ignoreViolations", ["x"]],
    ["bwrapPath", 42],
  ];

  it.each(wrong)("warns when sandbox.%s has the wrong type", (key, value) => {
    const d = find({ sandbox: { [key]: value } }, "settings-json/sandbox-field-type");
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain(`sandbox.${key}`);
  });

  it("reports the field path and a readable type in the message", () => {
    expect(find({ sandbox: { excludedCommands: "docker" } }, "settings-json/sandbox-field-type")?.message)
      .toBe('"sandbox.excludedCommands" should be an array of strings');
    expect(find({ sandbox: { enabled: "y" } }, "settings-json/sandbox-field-type")?.message)
      .toBe('"sandbox.enabled" should be a boolean');
  });

  it("flags a non-string element in excludedCommands", () => {
    expect(find({ sandbox: { excludedCommands: ["docker", 7] } }, "settings-json/sandbox-field-type")?.message)
      .toBe('"sandbox.excludedCommands" should be an array of strings');
  });

  it.each([
    ["network", {}],
    ["filesystem", {}],
    ["ripgrep", { command: "rg" }],
    ["ignoreViolations", {}],
  ])("accepts %s as an object", (key, value) => {
    expect(rules({ sandbox: { [key]: value } })).toEqual([]);
  });
});

// ──────────────────────────── scope behaviour ──────────────────────────────

describe("settings-json — project scope", () => {
  it("accepts permissions, sandbox and hooks in settings.local.json", () => {
    const r = diagnose({ permissions: {}, sandbox: {}, hooks: {} }, "project", "settings.local.json")
      .map((d) => d.rule);
    expect(r).not.toContain("settings-json/scope-field");
    expect(r).not.toContain("settings-json/no-unknown-fields");
  });

  it("still flags a genuine user-only field in settings.local.json", () => {
    // regression guard: the project-scope fix must not whitelist everything.
    // `apiKeyHelper` runs as the user — checking it into a repo would be
    // silently ignored by Claude Code.
    const d = diagnose({ apiKeyHelper: "/x" }, "project", "settings.local.json")
      .find((x) => x.rule === "settings-json/scope-field");
    expect(d?.severity).toBe("warning");
  });

  it("does not emit scope warnings at user scope", () => {
    expect(rules({ permissions: {}, sandbox: {}, model: "opus" }, "user")).toEqual([]);
  });
});

// ──────────────────────── config: enable / severity ────────────────────────

describe("settings-json — rule configuration", () => {
  it("suppresses a rule that is disabled in config", () => {
    const cfg: LinterConfig = { rules: { "settings-json/sandbox-field-type": false } };
    const d = settingsJsonLinter.lint(
      "settings.json", JSON.stringify({ sandbox: { enabled: "yes" } }), cfg, "user");
    expect(d.map((x) => x.rule)).not.toContain("settings-json/sandbox-field-type");
  });

  it("honours a severity override from config", () => {
    const cfg: LinterConfig = {
      rules: { "settings-json/sandbox-unknown-field": { enabled: true, severity: "error" } },
    };
    const d = settingsJsonLinter.lint(
      "settings.json", JSON.stringify({ sandbox: { bogus: 1 } }), cfg, "user");
    expect(d.find((x) => x.rule === "settings-json/sandbox-unknown-field")?.severity).toBe("error");
  });
});

// ─────────────────────── multiple findings at once ─────────────────────────

describe("settings-json — combined scenarios", () => {
  it("surfaces every distinct problem in one pass", () => {
    const r = rules({
      permissions: { ask: "WebFetch", defaultMode: "yolo", bogus: 1 },
      sandbox: { enabled: "yes", mystery: true },
    });
    expect(new Set(r)).toEqual(new Set([
      "settings-json/permissions-unknown-field",
      "settings-json/permissions-default-mode",
      "settings-json/ask-array",
      "settings-json/sandbox-field-type",
      "settings-json/sandbox-unknown-field",
      // The extracted JSON Schema also flags the same structural problems
      // (ask must be an array, sandbox.enabled must be a boolean).
      "settings-json/schema-valid",
    ]));
  });
});

// ───────────────────── auto-extracted JSON Schema rule ─────────────────────

describe("settings-json — schema-valid (auto-extracted JSON Schema)", () => {
  it("does not flag a valid settings object", () => {
    const r = rules({
      cleanupPeriodDays: 30,
      env: { FOO: "bar" },
      model: "claude-opus-4-7",
      verbose: true,
      theme: "dark",
      permissions: { allow: ["Read"], defaultMode: "default" },
      sandbox: { enabled: true, network: { allowedDomains: ["example.com"] } },
      enabledPlugins: { "x@y": true },
    });
    expect(r).not.toContain("settings-json/schema-valid");
  });

  it("flags a structurally-unchecked field with the wrong value type", () => {
    // cleanupPeriodDays must be a number per Claude Code's Zod schema; no
    // hand-written rule covers it, so only schema-valid catches the string.
    const d = find({ cleanupPeriodDays: "thirty" }, "settings-json/schema-valid");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain("cleanupPeriodDays");
  });

  it("flags a non-boolean where a boolean is expected", () => {
    const r = rules({ verbose: "yes" });
    expect(r).toContain("settings-json/schema-valid");
  });

  it("does not flag unknown top-level keys (schema top level is permissive)", () => {
    // .passthrough() means unknown keys are not schema errors — the advisory
    // no-unknown-fields rule reports them instead.
    const d = find({ someBrandNewSetting: 42 }, "settings-json/schema-valid");
    expect(d).toBeUndefined();
  });

  it("flags an invalid enum value on a known field", () => {
    const r = rules({ effortLevel: "ludicrous" });
    expect(r).toContain("settings-json/schema-valid");
  });

  it("does not flag a well-formed embedded hooks block", () => {
    // settings.json's `hooks` key resolves to the real hooks-config shape.
    const r = rules({
      hooks: {
        PreToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] },
        ],
      },
    });
    expect(r).not.toContain("settings-json/schema-valid");
  });

  it("flags a malformed hook inside the embedded hooks block", () => {
    // The `hooks` key is no longer a permissive placeholder — a hook with a
    // non-string `command` is now a structural error.
    const d = find(
      {
        hooks: {
          PreToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: 42 }] },
          ],
        },
      },
      "settings-json/schema-valid",
    );
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
  });

  it("flags malformed value types from a fixture file", () => {
    const path = resolve(
      import.meta.dirname,
      "fixtures/invalid/settings-json/bad-schema-types.json",
    );
    const diags = settingsJsonLinter.lint(
      path,
      readFileSync(path, "utf-8"),
      clean,
      "user",
    );
    expect(diags.some((d) => d.rule === "settings-json/schema-valid")).toBe(true);
  });

  it("is silenced when the rule is disabled", () => {
    const r = rules(
      { cleanupPeriodDays: "thirty" },
      "user",
    );
    // sanity: fires by default
    expect(r).toContain("settings-json/schema-valid");
    const disabled = settingsJsonLinter.lint(
      "settings.json",
      JSON.stringify({ cleanupPeriodDays: "thirty" }),
      { rules: { "settings-json/schema-valid": false } },
      "user",
    );
    expect(disabled.some((d) => d.rule === "settings-json/schema-valid")).toBe(false);
  });
});

// ───────────────────────── contract / rule wiring ──────────────────────────

describe("settings-json — contracts & rule registry", () => {
  it("extracted contracts are populated", () => {
    expect(PERMISSION_MODES.size).toBeGreaterThanOrEqual(6);
    expect(PERMISSIONS_FIELDS).toContain("allow");
    expect(PERMISSIONS_FIELDS).toContain("defaultMode");
    expect(SANDBOX_FIELDS).toContain("network");
    expect(SANDBOX_FIELDS).toContain("filesystem");
    expect(SANDBOX_NETWORK_FIELDS).toContain("allowedDomains");
    expect(SANDBOX_NETWORK_FIELDS).toContain("httpProxyPort");
    expect(SANDBOX_FILESYSTEM_FIELDS).toContain("allowWrite");
    expect(SANDBOX_FILESYSTEM_FIELDS).toContain("denyRead");
    for (const m of ["acceptEdits", "bypassPermissions", "plan", "default"]) {
      expect(PERMISSION_MODES).toContain(m);
    }
  });

  it("registers the new rules with their intended severities", () => {
    const byId = new Map(SETTINGS_JSON_RULES.map((r) => [r.id, r.defaultSeverity]));
    expect(byId.get("settings-json/permissions-unknown-field")).toBe("warning");
    expect(byId.get("settings-json/permissions-default-mode")).toBe("warning");
    expect(byId.get("settings-json/permissions-disable-bypass")).toBe("warning");
    expect(byId.get("settings-json/permissions-field-type")).toBe("warning");
    expect(byId.get("settings-json/ask-array")).toBe("error");
    expect(byId.get("settings-json/permission-rule-syntax")).toBe("error");
    expect(byId.get("settings-json/permission-rule-pattern")).toBe("error");
    expect(byId.get("settings-json/sandbox-object")).toBe("error");
    expect(byId.get("settings-json/sandbox-unknown-field")).toBe("warning");
    expect(byId.get("settings-json/sandbox-field-type")).toBe("warning");
  });
});

// ───────────────── tier 1: permissions field types ─────────────────────────

describe("settings-json permissions — additionalDirectories & disableAutoMode", () => {
  it("accepts a string array for additionalDirectories", () => {
    expect(rules({ permissions: { additionalDirectories: ["../a", "../b"] } })).toEqual([]);
  });

  it.each([
    ["a bare string", "../a"],
    ["an array with a non-string", ["../a", 3]],
  ])("flags additionalDirectories given %s", (_label, value) => {
    const d = find({ permissions: { additionalDirectories: value } }, "settings-json/permissions-field-type");
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain("additionalDirectories");
  });

  it("accepts a boolean disableAutoMode and flags a non-boolean", () => {
    expect(rules({ permissions: { disableAutoMode: true } })).toEqual([]);
    expect(find({ permissions: { disableAutoMode: "yes" } }, "settings-json/permissions-field-type")?.severity)
      .toBe("warning");
  });
});

// ───────────────── tier 3: permission-rule syntax ──────────────────────────

describe("settings-json — permission-rule syntax", () => {
  it.each([
    ["allow"], ["deny"], ["ask"],
  ])("accepts well-formed rules in %s", (key) => {
    expect(rules({ permissions: {
      [key]: ["Read", "Bash(npm run build:*)", "Edit(src/**)", "mcp__gh__search", "WebFetch(domain:x.com)"],
    } })).toEqual([]);
  });

  it.each([
    ["empty string", "", "cannot be empty"],
    ["unbalanced open paren", "Bash(", "mismatched parentheses"],
    ["unbalanced close paren", "Bash))", "mismatched parentheses"],
    ["empty parentheses", "Bash()", "empty parentheses"],
    ["lowercase tool name", "bash(ls)", "uppercase"],
    ["mcp rule with a pattern", "mcp__gh__search(x)", "MCP rules do not support"],
  ])("flags %s as a rule-syntax error", (_label, rule, fragment) => {
    const d = find({ permissions: { allow: [rule] } }, "settings-json/permission-rule-syntax");
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain(fragment);
  });

  it("checks deny and ask rules too", () => {
    expect(rules({ permissions: { deny: ["Bash("] } })).toContain("settings-json/permission-rule-syntax");
    expect(rules({ permissions: { ask: ["bash(x)"] } })).toContain("settings-json/permission-rule-syntax");
  });

  it("suppresses the unknown-tool check when a rule is syntactically broken", () => {
    // a malformed rule reports syntax only — not a redundant unknown-tool warning
    const r = rules({ permissions: { allow: ["Banana("] } });
    expect(r).toContain("settings-json/permission-rule-syntax");
    expect(r).not.toContain("settings-json/allow-known-tools");
  });

  it("does not treat a valid mcp rule without a pattern as an error", () => {
    expect(rules({ permissions: { allow: ["mcp__server__tool"] } })).toEqual([]);
  });
});

// ───────────────── tier 2: sandbox nested objects ──────────────────────────

describe("settings-json sandbox — ripgrep", () => {
  it("accepts a valid ripgrep block", () => {
    expect(rules({ sandbox: { ripgrep: { command: "rg", args: ["--hidden"] } } })).toEqual([]);
    expect(rules({ sandbox: { ripgrep: { command: "rg" } } })).toEqual([]);
  });

  it("flags a missing required command", () => {
    const d = find({ sandbox: { ripgrep: {} } }, "settings-json/sandbox-field-type");
    expect(d?.message).toContain("sandbox.ripgrep.command");
  });

  it("flags args that are not a string array", () => {
    expect(find({ sandbox: { ripgrep: { command: "rg", args: "--hidden" } } },
      "settings-json/sandbox-field-type")?.message).toContain("sandbox.ripgrep.args");
  });

  it("flags an unknown ripgrep sub-key", () => {
    expect(find({ sandbox: { ripgrep: { command: "rg", flags: [] } } },
      "settings-json/sandbox-unknown-field")?.message).toContain("sandbox.ripgrep.flags");
  });
});

describe("settings-json sandbox — ignoreViolations", () => {
  it("accepts a record of string arrays", () => {
    expect(rules({ sandbox: { ignoreViolations: { Bash: ["r1"], Edit: [] } } })).toEqual([]);
  });

  it("flags a value that is not a string array", () => {
    expect(find({ sandbox: { ignoreViolations: { Bash: "r1" } } }, "settings-json/sandbox-field-type")?.message)
      .toContain("sandbox.ignoreViolations.Bash");
    expect(rules({ sandbox: { ignoreViolations: { Bash: [1] } } }))
      .toContain("settings-json/sandbox-field-type");
  });
});

describe("settings-json sandbox — network", () => {
  it("accepts a fully-populated network block", () => {
    expect(rules({ sandbox: { network: {
      allowedDomains: ["a.com"], deniedDomains: ["b.com"], allowManagedDomainsOnly: true,
      allowUnixSockets: ["/run/x"], allowAllUnixSockets: false, allowLocalBinding: true,
      allowMachLookup: ["com.apple.x"], httpProxyPort: 8080, socksProxyPort: 1080,
      tlsTerminate: {},
    } } })).toEqual([]);
  });

  it("flags an unknown network sub-key", () => {
    expect(find({ sandbox: { network: { allowedDmains: [] } } }, "settings-json/sandbox-unknown-field")?.message)
      .toBe('Unknown field "sandbox.network.allowedDmains"');
  });

  it.each([
    ["allowedDomains", "a.com", "an array of strings"],
    ["allowManagedDomainsOnly", "yes", "a boolean"],
    ["httpProxyPort", "8080", "a number"],
  ])("flags network.%s with the wrong type", (key, value, fragment) => {
    const d = find({ sandbox: { network: { [key]: value } } }, "settings-json/sandbox-field-type");
    expect(d?.message).toContain(`sandbox.network.${key}`);
    expect(d?.message).toContain(fragment);
  });
});

describe("settings-json sandbox — filesystem", () => {
  it("accepts a fully-populated filesystem block", () => {
    expect(rules({ sandbox: { filesystem: {
      allowWrite: ["/tmp"], denyWrite: ["/etc"], denyRead: ["/etc/shadow"],
      allowRead: ["/etc/hosts"], allowManagedReadPathsOnly: true,
    } } })).toEqual([]);
  });

  it("flags an unknown filesystem sub-key", () => {
    expect(rules({ sandbox: { filesystem: { allowWriteAll: true } } }))
      .toContain("settings-json/sandbox-unknown-field");
  });

  it.each([
    ["allowWrite", "yep"],
    ["allowManagedReadPathsOnly", []],
  ])("flags filesystem.%s with the wrong type", (key, value) => {
    expect(find({ sandbox: { filesystem: { [key]: value } } }, "settings-json/sandbox-field-type")?.message)
      .toContain(`sandbox.filesystem.${key}`);
  });
});

describe("settings-json sandbox — network.tlsTerminate", () => {
  it("accepts a valid tlsTerminate block", () => {
    expect(rules({ sandbox: { network: { tlsTerminate: {
      caCertPath: "/etc/ca.pem", caKeyPath: "/etc/ca.key",
    } } } })).toEqual([]);
    expect(rules({ sandbox: { network: { tlsTerminate: {} } } })).toEqual([]);
  });

  it("flags an unknown tlsTerminate sub-key", () => {
    expect(find({ sandbox: { network: { tlsTerminate: { caCert: "x" } } } },
      "settings-json/sandbox-unknown-field")?.message)
      .toBe('Unknown field "sandbox.network.tlsTerminate.caCert"');
  });

  it("flags a non-string tlsTerminate path", () => {
    expect(find({ sandbox: { network: { tlsTerminate: { caCertPath: 7 } } } },
      "settings-json/sandbox-field-type")?.message)
      .toContain("sandbox.network.tlsTerminate.caCertPath");
  });
});

// ───────────── tier 1 (#1): per-tool permission-rule pattern grammar ────────

describe("settings-json — permission-rule pattern grammar", () => {
  it("accepts well-formed per-tool patterns", () => {
    expect(rules({ permissions: { allow: [
      "Bash(npm run build:*)",   // :* prefix marker at the end
      "Bash(git status)",
      "Bash(*)",                 // bare wildcard
      "Edit(src/**)",
      "Read(**/*.ts)",
      "WebFetch(domain:example.com)",
      "WebFetch(domain:*.google.com)",
      "WebSearch(typescript tutorial)",
    ] } })).toEqual([]);
  });

  it.each([
    ["WebSearch with a wildcard", "WebSearch(claude*)", "wildcards"],
    ["WebFetch with a URL", "WebFetch(https://example.com)", "not URLs"],
    ["WebFetch without domain: prefix", "WebFetch(example.com)", "domain:"],
    ["Bash :* not at the end", "Bash(npm:* run)", "must be at the end"],
    ["Bash :* with an empty prefix", "Bash(:*)", "cannot be empty"],
    ["Edit using Bash-only :* syntax", "Edit(src:*)", "Bash-only"],
    ["Read using Bash-only :* syntax", "Read(node_modules:*)", "Bash-only"],
  ])("flags %s", (_label, rule, fragment) => {
    const d = find({ permissions: { allow: [rule] } }, "settings-json/permission-rule-pattern");
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain(fragment);
  });

  it("checks pattern grammar in deny and ask too", () => {
    expect(rules({ permissions: { deny: ["WebFetch(http://x.com)"] } }))
      .toContain("settings-json/permission-rule-pattern");
    expect(rules({ permissions: { ask: ["Bash(:*)"] } }))
      .toContain("settings-json/permission-rule-pattern");
  });

  it("treats () and (*) as a bare tool — no pattern error", () => {
    expect(rules({ permissions: { allow: ["WebFetch(*)"] } })).toEqual([]);
  });
});
