/**
 * Cross-file reference helpers (oleks/claudecode-linter#51): root discovery,
 * root-bounded path checks, and extraction of the references Claude Code
 * follows at runtime — hook script paths, CLAUDE.md `@imports` and markdown
 * links — with code fences, code spans and HTML comments skipped.
 *
 * Callers only ever READ files inside a discovered plugin/project root; paths
 * outside it are existence-checked, never opened.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Walk up from `fromFile` to the directory holding `.claude-plugin/plugin.json`. */
export function findPluginRoot(fromFile: string): string | null {
  let dir = dirname(resolve(fromFile));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Walk up from `fromFile` to the nearest directory holding `.git` or
 * `.claude/` — what Claude Code treats as the project. Null when neither is
 * found, so callers can skip project-relative checks instead of guessing.
 */
export function findProjectRoot(fromFile: string): string | null {
  let dir = dirname(resolve(fromFile));
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git")) || isDir(join(dir, ".claude"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when `p` is `root` or lies beneath it (no `..` escape). */
export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── hook commands ─────────────────────────────────────────────────────

export interface HookScriptRef {
  /** The path as written, e.g. `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`. */
  raw: string;
  /** Absolute path after substituting the root variable. */
  resolved: string;
}

/** Split a shell command into words, honouring single and double quotes. */
function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
    } else if (/\s/.test(c) || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/**
 * Paths a hook command references through a root variable. Only words that
 * START with `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` (or the bare
 * `$VAR` form) are checked, and only when that root is known; words that
 * still hold `$`, a glob or `~` after substitution can't be resolved
 * statically and are skipped.
 */
export function hookScriptRefs(
  command: string,
  roots: { plugin?: string | null; project?: string | null },
): HookScriptRef[] {
  const out: HookScriptRef[] = [];
  for (const word of shellWords(command)) {
    // `--flag=${CLAUDE_PLUGIN_ROOT}/x` → check the value part.
    const candidate = word.replace(/^-[\w-]*=/, "");
    const m = /^\$(?:\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}|(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\b)(.*)$/.exec(candidate);
    if (!m) continue;
    const root = (m[1] ?? m[2]) === "CLAUDE_PLUGIN_ROOT" ? roots.plugin : roots.project;
    if (!root) continue;
    const rest = m[3];
    if (/[$*?[{~`]/.test(rest)) continue;
    out.push({ raw: candidate, resolved: join(root, rest) });
  }
  return out;
}

/** Every `type: "command"` hook's command string in a hooks map. */
export function commandHooks(hooks: unknown): { event: string; command: string }[] {
  const out: { event: string; command: string }[] = [];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return out;
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (typeof matcher !== "object" || matcher === null) continue;
      const list = (matcher as Record<string, unknown>).hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        if (typeof h !== "object" || h === null) continue;
        const r = h as Record<string, unknown>;
        if (r.type === "command" && typeof r.command === "string") {
          out.push({ event, command: r.command });
        }
      }
    }
  }
  return out;
}

// ── markdown text (code-aware) ────────────────────────────────────────

/**
 * Blank out what Claude Code's markdown lexer would not hand over as text:
 * fenced code blocks, inline code spans and HTML comments. Line structure
 * and column offsets are preserved so callers can report positions.
 */
export function proseOnly(content: string): string[] {
  const lines = content.split("\n");
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let inComment = false;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      out.push("");
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open && !inComment) {
      fence = { char: open[1][0], len: open[1].length };
      out.push("");
      continue;
    }
    let s = line;
    // HTML comments, possibly spanning lines.
    let res = "";
    let i = 0;
    while (i < s.length) {
      if (inComment) {
        const end = s.indexOf("-->", i);
        if (end === -1) {
          res += " ".repeat(s.length - i);
          i = s.length;
        } else {
          res += " ".repeat(end + 3 - i);
          i = end + 3;
          inComment = false;
        }
      } else {
        const start = s.indexOf("<!--", i);
        if (start === -1) {
          res += s.slice(i);
          i = s.length;
        } else {
          res += s.slice(i, start);
          i = start;
          inComment = true;
        }
      }
    }
    s = res;
    // Inline code spans: a run of N backticks closed by the same run.
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => " ".repeat(m.length));
    out.push(s);
  }
  return out;
}

// ── CLAUDE.md @imports ────────────────────────────────────────────────

export interface ImportRef {
  /** Path as written after `@`, with any `#fragment` dropped. */
  path: string;
  line: number;
  column: number;
}

/**
 * `@path` imports as Claude Code's loader extracts them (verified against
 * 2.1.301): `(?:^|\s)@((?:[^\s\\]|\\ )+)` over prose only, `#fragment`
 * stripped, `\ ` unescaped, and accepted only when the path starts with
 * `./`, `~/`, `/` (not bare `/`) or a `[a-zA-Z0-9._-]` character.
 */
export function extractImports(content: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = proseOnly(content);
  for (let i = 0; i < lines.length; i++) {
    const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
    for (;;) {
      const m = re.exec(lines[i]);
      if (m === null) break;
      let p = m[1];
      const hash = p.indexOf("#");
      if (hash !== -1) p = p.substring(0, hash);
      p = p.replaceAll("\\ ", " ");
      if (!p) continue;
      const accepted =
        p.startsWith("./") ||
        p.startsWith("~/") ||
        (p.startsWith("/") && p !== "/") ||
        (!p.startsWith("@") && !/^[#%^&*()]+/.test(p) && /^[a-zA-Z0-9._-]/.test(p));
      if (!accepted) continue;
      const at = m.index + m[0].indexOf("@");
      out.push({ path: p, line: i + 1, column: at + 1 });
    }
  }
  return out;
}

/** Resolve an import path the way Claude Code does: `~/` → home, else against the importing file's dir. */
export function resolveImport(p: string, fromFile: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(dirname(fromFile), p);
}

// ── markdown links ────────────────────────────────────────────────────

export interface LinkRef {
  target: string;
  line: number;
  column: number;
}

/**
 * Local file targets of inline markdown links and images in prose. URLs
 * (any `scheme:`), pure anchors, absolute and `~` paths, and targets holding
 * `$`/`{` (env vars, templates) are dropped; `#fragment` and `?query` are
 * stripped and percent-escapes decoded.
 */
export function extractLocalLinks(content: string): LinkRef[] {
  const out: LinkRef[] = [];
  const lines = proseOnly(content);
  for (let i = 0; i < lines.length; i++) {
    const re = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'(][^)]*)?\)/g;
    for (;;) {
      const m = re.exec(lines[i]);
      if (m === null) break;
      let t = m[1];
      if (t.startsWith("<")) t = t.slice(1, -1);
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) continue;
      if (t.startsWith("#") || t.startsWith("/") || t.startsWith("~") || /[${]/.test(t)) continue;
      t = t.replace(/[#?].*$/, "");
      if (!t) continue;
      try {
        t = decodeURIComponent(t);
      } catch {
        // keep the raw form
      }
      out.push({ target: t, line: i + 1, column: m.index + 1 });
    }
  }
  return out;
}
