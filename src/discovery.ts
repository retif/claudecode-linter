import { statSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve, join, relative } from "node:path";
import { homedir } from "node:os";
import { globSync } from "tinyglobby";
import { minimatch } from "minimatch";
import type { ArtifactType, ConfigScope, DiscoveredArtifact } from "./types.js";

const CLAUDE_USER_DIR = join(homedir(), ".claude");

export interface DiscoverOptions {
  /** Filter artifacts by scope, or override detected scope */
  scope?: ConfigScope;
  /** Glob patterns to ignore (in addition to .claudecode-lint-ignore) */
  ignore?: string[];
}

function loadIgnoreFile(dir: string): string[] {
  const ignoreFile = join(dir, ".claudecode-lint-ignore");
  if (!existsSync(ignoreFile)) return [];
  return readFileSync(ignoreFile, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isIgnored(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const abs = resolve(filePath);
  for (const pattern of patterns) {
    // Match against absolute path
    if (minimatch(abs, pattern, { matchBase: true, dot: true })) return true;
    // Also match against the basename alone (for simple patterns like "*.md")
    if (minimatch(basename(abs), pattern, { dot: true })) return true;
  }
  return false;
}

export function discoverArtifacts(targetPath: string, options?: DiscoverOptions): DiscoveredArtifact[] {
  const resolved = resolve(targetPath);
  const stat = statSync(resolved);

  // Combine .claudecode-lint-ignore patterns with CLI --ignore patterns
  const ignoreDir = stat.isDirectory() ? resolved : dirname(resolved);
  const ignorePatterns = [
    ...loadIgnoreFile(ignoreDir),
    ...(options?.ignore ?? []),
  ];

  let artifacts: DiscoveredArtifact[];

  if (!stat.isDirectory()) {
    const type = classifyFile(resolved);
    if (type) {
      artifacts = [{ filePath: resolved, artifactType: type, scope: detectScope(resolved) }];
    } else {
      artifacts = [];
    }
  } else {
    artifacts = discoverInDirectory(resolved);

    // If targeting home dir, also discover in ~/.claude/
    const home = homedir();
    if (resolved === home && existsSync(CLAUDE_USER_DIR)) {
      const userArtifacts = discoverInDirectory(CLAUDE_USER_DIR);
      // Deduplicate by filePath
      const seen = new Set(artifacts.map((a) => a.filePath));
      for (const a of userArtifacts) {
        if (!seen.has(a.filePath)) artifacts.push(a);
      }
    }
  }

  // Apply ignore patterns
  if (ignorePatterns.length > 0) {
    artifacts = artifacts.filter((a) => !isIgnored(a.filePath, ignorePatterns));
  }

  // Apply scope filter/override
  if (options?.scope) {
    artifacts = artifacts
      .map((a) => ({ ...a, scope: a.scope ?? options.scope }))
      .filter((a) => a.scope === options.scope);
  }

  return artifacts;
}

function detectScope(filePath: string): ConfigScope | undefined {
  const resolved = resolve(filePath);

  // Inside ~/.claude/ itself (not a subdirectory project)
  if (resolved.startsWith(CLAUDE_USER_DIR + "/")) {
    const relative = resolved.slice(CLAUDE_USER_DIR.length + 1);
    // Files directly in ~/.claude/ (settings.json, mcp.json, CLAUDE.md)
    if (!relative.includes("/") || relative.startsWith("plugins/")) {
      return "user";
    }
  }

  // Inside a project's .claude/ directory
  const name = basename(filePath);
  const parent = basename(dirname(filePath));

  if (parent === ".claude") {
    // Check if this .claude/ is inside another .claude/ (subdirectory scope)
    const projectDir = dirname(dirname(filePath));
    if (isSubdirectoryProject(projectDir)) {
      return "subdirectory";
    }
    return "project";
  }

  // CLAUDE.md
  if (name === "CLAUDE.md") {
    const dir = dirname(resolved);
    if (dir === CLAUDE_USER_DIR || dir === homedir()) return "user";
    return "project";
  }

  // .mcp.json at project root
  if (name === ".mcp.json") return "project";

  // settings files directly in ~/.claude/
  if (name === "settings.json" && dirname(resolved) === CLAUDE_USER_DIR) {
    return "user";
  }
  // settings.local.json in ~/.claude/ — this is misplaced (user level), detect it so the linter can warn
  if (name === "settings.local.json" && dirname(resolved) === CLAUDE_USER_DIR) {
    return "user";
  }

  return undefined;
}

function isSubdirectoryProject(dir: string): boolean {
  // Walk up looking for a parent with .claude-plugin/ or another .claude/
  let current = dirname(dir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, ".claude-plugin"))) return true;
    if (existsSync(join(current, ".claude")) && current !== dir) return true;
    if (existsSync(join(current, ".git"))) return false; // reached git root
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function discoverInDirectory(dir: string): DiscoveredArtifact[] {
  const artifacts: DiscoveredArtifact[] = [];
  const isUserDir = resolve(dir) === CLAUDE_USER_DIR;

  // plugin.json
  const pluginJsons = globSync(".claude-plugin/plugin.json", { cwd: dir, absolute: true });
  for (const f of pluginJsons) {
    artifacts.push({ filePath: f, artifactType: "plugin-json" });
  }

  // SKILL.md files
  const skills = globSync("skills/*/SKILL.md", { cwd: dir, absolute: true });
  for (const f of skills) {
    artifacts.push({ filePath: f, artifactType: "skill-md" });
  }

  // Agent definitions (plugin agents/ and .claude/agents/)
  const agentPatterns = isUserDir
    ? ["agents/*.md"]
    : ["agents/*.md", ".claude/agents/*.md"];
  for (const pattern of agentPatterns) {
    const agents = globSync(pattern, { cwd: dir, absolute: true });
    for (const f of agents) {
      artifacts.push({ filePath: f, artifactType: "agent-md" });
    }
  }

  // Command definitions
  const commands = globSync("commands/*.md", { cwd: dir, absolute: true });
  for (const f of commands) {
    artifacts.push({ filePath: f, artifactType: "command-md" });
  }

  // hooks.json
  const hooks = globSync("hooks/hooks.json", { cwd: dir, absolute: true });
  for (const f of hooks) {
    artifacts.push({ filePath: f, artifactType: "hooks-json" });
  }

  // Claude config files — settings
  for (const name of ["settings.json", "settings.local.json"]) {
    // Direct in dir (handles both ~/.claude/settings.json and project root)
    const atRoot = join(dir, name);
    if (existsSync(atRoot)) {
      artifacts.push({ filePath: atRoot, artifactType: "settings-json", scope: detectScope(atRoot) });
    }
    // In .claude/ subdirectory (skip if we're already in ~/.claude/)
    if (!isUserDir) {
      const inClaude = join(dir, ".claude", name);
      if (existsSync(inClaude) && !existsSync(atRoot)) {
        artifacts.push({ filePath: inClaude, artifactType: "settings-json", scope: detectScope(inClaude) });
      }
    }
  }

  // MCP config
  const mcpDot = join(dir, ".mcp.json");
  if (existsSync(mcpDot)) {
    artifacts.push({ filePath: mcpDot, artifactType: "mcp-json", scope: detectScope(mcpDot) });
  }
  const mcpPlain = join(dir, "mcp.json");
  if (existsSync(mcpPlain)) {
    artifacts.push({ filePath: mcpPlain, artifactType: "mcp-json", scope: detectScope(mcpPlain) });
  }

  // CLAUDE.md
  const claudeMd = join(dir, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    artifacts.push({ filePath: claudeMd, artifactType: "claude-md", scope: detectScope(claudeMd) });
  }

  return artifacts;
}

function classifyFile(filePath: string): ArtifactType | null {
  const name = basename(filePath);
  const parent = basename(dirname(filePath));

  if (name === "plugin.json" && parent === ".claude-plugin") return "plugin-json";
  if (name === "SKILL.md") return "skill-md";
  if (name === "hooks.json" && parent === "hooks") return "hooks-json";
  if (name.endsWith(".md") && parent === "agents") return "agent-md";
  if (name.endsWith(".md") && parent === "commands") return "command-md";

  // Claude config files
  if (name === "settings.json" || name === "settings.local.json") return "settings-json";
  if (name === ".mcp.json" || name === "mcp.json") return "mcp-json";
  if (name === "CLAUDE.md") return "claude-md";

  return null;
}
