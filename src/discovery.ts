import { statSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve, join, relative } from "node:path";
import { homedir } from "node:os";
import { globSync } from "tinyglobby";
import { minimatch } from "minimatch";
import {
	CANONICAL_ARTIFACTS,
	isCanonicalLocation,
} from "./canonical-paths.js";
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

export function discoverArtifacts(
	targetPath: string,
	options?: DiscoverOptions,
): DiscoveredArtifact[] {
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
			artifacts = [
				{
					filePath: resolved,
					artifactType: type,
					scope: detectScope(resolved),
				},
			];
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

/**
 * Detect which Claude Code artifact types are present under the given paths.
 * Returns the distinct types, sorted; excludes the `misplaced-file` diagnostic
 * category (it marks a misplacement, not a kind of artifact a project owns).
 * An empty result means the path holds no recognizable Claude Code artifacts.
 *
 * Powers the `--detect` CLI mode: a generic git hook can call it to decide
 * whether a repository is a Claude Code plugin / config tree before linting.
 */
export function detectArtifactTypes(
	paths: string[],
	ignore: string[] = [],
): ArtifactType[] {
	const found = new Set<ArtifactType>();
	for (const targetPath of paths) {
		for (const a of discoverArtifacts(targetPath, { ignore })) {
			if (a.artifactType !== "misplaced-file") found.add(a.artifactType);
		}
	}
	return [...found].sort();
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

	// Inside a project's .claude/ directory — either directly
	// (`.claude/settings.json`) or in one of the artifact subdirectories
	// Claude Code reads project-locally (`.claude/skills/<name>/SKILL.md`,
	// `.claude/agents/*.md`, `.claude/commands/*.md`). The user-level
	// `~/.claude/` is excluded: it is handled by the block above and by the
	// per-name rules below.
	const name = basename(filePath);
	const claudeDir = projectLocalClaudeDir(resolved);

	if (claudeDir !== undefined && claudeDir !== CLAUDE_USER_DIR) {
		// Check if this .claude/ is inside another .claude/ (subdirectory scope)
		if (isSubdirectoryProject(dirname(claudeDir))) {
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

/**
 * The `.claude/` directory `filePath` belongs to, when the file sits at one
 * of the shapes Claude Code actually reads project-locally, or undefined
 * otherwise.
 *
 * Deliberately an allow-list of exact shapes rather than "nearest ancestor
 * named `.claude`" — the same reasoning as `canonical-paths.ts`. An upward
 * walk matches any distant ancestor, so a plugin's own `skills/x/SKILL.md`
 * checked out under some outer `.claude/worktrees/` would be mis-scoped as
 * project-local. These four shapes cannot do that.
 */
function projectLocalClaudeDir(filePath: string): string | undefined {
	const resolved = resolve(filePath);
	const parent = dirname(resolved);

	// .claude/<file> — e.g. settings.json, keybindings.json
	if (basename(parent) === ".claude") return parent;

	// .claude/agents/<file>.md, .claude/commands/<file>.md
	const grandparent = dirname(parent);
	const parentName = basename(parent);
	if (
		(parentName === "agents" || parentName === "commands") &&
		basename(grandparent) === ".claude"
	) {
		return grandparent;
	}

	// .claude/skills/<name>/SKILL.md
	if (
		basename(resolved) === "SKILL.md" &&
		basename(grandparent) === "skills" &&
		basename(dirname(grandparent)) === ".claude"
	) {
		return dirname(grandparent);
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
	const pluginJsons = globSync(".claude-plugin/plugin.json", {
		cwd: dir,
		absolute: true,
	});
	for (const f of pluginJsons) {
		artifacts.push({ filePath: f, artifactType: "plugin-json" });
	}

	// SKILL.md files (plugin skills/ and .claude/skills/)
	const skillPatterns = isUserDir
		? ["skills/*/SKILL.md"]
		: ["skills/*/SKILL.md", ".claude/skills/*/SKILL.md"];
	for (const pattern of skillPatterns) {
		const skills = globSync(pattern, { cwd: dir, absolute: true });
		for (const f of skills) {
			artifacts.push({
				filePath: f,
				artifactType: "skill-md",
				scope: detectScope(f),
			});
		}
	}

	// Agent definitions (plugin agents/ and .claude/agents/)
	const agentPatterns = isUserDir
		? ["agents/*.md"]
		: ["agents/*.md", ".claude/agents/*.md"];
	for (const pattern of agentPatterns) {
		const agents = globSync(pattern, { cwd: dir, absolute: true });
		for (const f of agents) {
			artifacts.push({
				filePath: f,
				artifactType: "agent-md",
				scope: detectScope(f),
			});
		}
	}

	// Command definitions (plugin commands/ and .claude/commands/)
	const commandPatterns = isUserDir
		? ["commands/*.md"]
		: ["commands/*.md", ".claude/commands/*.md"];
	for (const pattern of commandPatterns) {
		const commands = globSync(pattern, { cwd: dir, absolute: true });
		for (const f of commands) {
			artifacts.push({
				filePath: f,
				artifactType: "command-md",
				scope: detectScope(f),
			});
		}
	}

	// hooks.json
	const hooks = globSync("hooks/hooks.json", { cwd: dir, absolute: true });
	for (const f of hooks) {
		artifacts.push({ filePath: f, artifactType: "hooks-json" });
	}

	// .lsp.json (flat record at plugin root; Claude Code reads from <plugin>/.lsp.json)
	const lspDot = join(dir, ".lsp.json");
	if (existsSync(lspDot)) {
		artifacts.push({ filePath: lspDot, artifactType: "lsp-json" });
	}

	// monitors/monitors.json
	const monitors = globSync("monitors/monitors.json", {
		cwd: dir,
		absolute: true,
	});
	for (const f of monitors) {
		artifacts.push({ filePath: f, artifactType: "monitors-json" });
	}

	// .claude-plugin/marketplace.json — schemastore-only artifact.
	const marketplace = join(dir, ".claude-plugin", "marketplace.json");
	if (existsSync(marketplace)) {
		artifacts.push({ filePath: marketplace, artifactType: "marketplace-json" });
	}

	// keybindings.json — usually at ~/.claude/keybindings.json (user scope),
	// but also picked up at project root if present. schemastore-only artifact.
	for (const candidate of [
		join(dir, "keybindings.json"),
		join(dir, ".claude", "keybindings.json"),
	]) {
		if (existsSync(candidate)) {
			artifacts.push({
				filePath: candidate,
				artifactType: "keybindings-json",
				scope: detectScope(candidate),
			});
		}
	}

	// Claude config files — settings
	for (const name of ["settings.json", "settings.local.json"]) {
		// Direct in dir (handles both ~/.claude/settings.json and project root)
		const atRoot = join(dir, name);
		if (existsSync(atRoot)) {
			artifacts.push({
				filePath: atRoot,
				artifactType: "settings-json",
				scope: detectScope(atRoot),
			});
		}
		// In .claude/ subdirectory (skip if we're already in ~/.claude/)
		if (!isUserDir) {
			const inClaude = join(dir, ".claude", name);
			if (existsSync(inClaude) && !existsSync(atRoot)) {
				artifacts.push({
					filePath: inClaude,
					artifactType: "settings-json",
					scope: detectScope(inClaude),
				});
			}
		}
	}

	// MCP config
	const mcpDot = join(dir, ".mcp.json");
	if (existsSync(mcpDot)) {
		artifacts.push({
			filePath: mcpDot,
			artifactType: "mcp-json",
			scope: detectScope(mcpDot),
		});
	}
	const mcpPlain = join(dir, "mcp.json");
	if (existsSync(mcpPlain)) {
		artifacts.push({
			filePath: mcpPlain,
			artifactType: "mcp-json",
			scope: detectScope(mcpPlain),
		});
	}

	// CLAUDE.md
	const claudeMd = join(dir, "CLAUDE.md");
	if (existsSync(claudeMd)) {
		artifacts.push({
			filePath: claudeMd,
			artifactType: "claude-md",
			scope: detectScope(claudeMd),
		});
	}

	// Misplaced-file scan: only meaningful inside a plugin tree
	// (we use `.claude-plugin/` as the marker). Outside plugin
	// trees, a stray `plugin.json` / `hooks.json` could legitimately
	// belong to some other tool and we don't want to false-positive.
	if (existsSync(join(dir, ".claude-plugin"))) {
		for (const m of findMisplacedFiles(dir)) {
			artifacts.push(m);
		}
	}

	return artifacts;
}

/**
 * Walk `pluginRoot` looking for files whose basename is reserved
 * for a Claude Code artifact and which Claude Code reads only from
 * a single canonical path. Anything matching a basename but
 * sitting at a non-canonical location is returned as a
 * `misplaced-file` artifact for the misplaced-file linter to flag.
 *
 * Ignores typical noise dirs (`node_modules`, `.git`, `dist`,
 * `.claude/worktrees/` worktree copies, the plugin install cache's
 * `.in_use` / `.orphaned_at` markers).
 */
function findMisplacedFiles(pluginRoot: string): DiscoveredArtifact[] {
	const out: DiscoveredArtifact[] = [];
	for (const entry of CANONICAL_ARTIFACTS) {
		const found = globSync(`**/${entry.basename}`, {
			cwd: pluginRoot,
			absolute: true,
			// dot: walk into dot-directories like `.claude-plugin/`
			// — that's exactly where the most common misplacement
			// (hooks.json under `.claude-plugin/` instead of plugin
			// root's `hooks/`) lives.
			dot: true,
			ignore: [
				"**/node_modules/**",
				"**/.git/**",
				// `.claude/worktrees/` holds transient git-worktree copies
				// (Claude Code's own EnterWorktree). Linting them re-reports
				// every artifact once per worktree — pure noise.
				"**/.claude/worktrees/**",
				"**/dist/**",
				"**/.in_use/**",
				"**/.orphaned_at/**",
			],
		});
		for (const filePath of found) {
			const rel = relative(pluginRoot, filePath);
			if (!isCanonicalLocation(rel, entry)) {
				out.push({ filePath, artifactType: "misplaced-file" });
			}
		}
	}
	return out;
}

function classifyFile(filePath: string): ArtifactType | null {
	const name = basename(filePath);
	const parent = basename(dirname(filePath));

	if (name === "plugin.json" && parent === ".claude-plugin")
		return "plugin-json";
	if (name === "marketplace.json" && parent === ".claude-plugin")
		return "marketplace-json";
	if (name === "keybindings.json") return "keybindings-json";
	if (name === "SKILL.md") return "skill-md";
	if (name === "hooks.json" && parent === "hooks") return "hooks-json";
	if (name === ".lsp.json") return "lsp-json";
	if (name === "monitors.json" && parent === "monitors") return "monitors-json";
	if (name.endsWith(".md") && parent === "agents") return "agent-md";
	if (name.endsWith(".md") && parent === "commands") return "command-md";

	// Claude config files
	if (name === "settings.json" || name === "settings.local.json")
		return "settings-json";
	if (name === ".mcp.json" || name === "mcp.json") return "mcp-json";
	if (name === "CLAUDE.md") return "claude-md";

	return null;
}
