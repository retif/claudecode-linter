import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Fixer, LinterConfig } from "../types.js";
import { toKebabCase, isKebabCase } from "../utils/kebab-case.js";

/**
 * Pre-parse fixer: fix common YAML syntax errors in raw frontmatter lines
 * before attempting to parse. This allows fixing files that would otherwise
 * be unparseable.
 */
function preParseFixFrontmatter(fmLines: string[]): string[] {
  return fmLines.map((line) => {
    // Match "key: value" lines where the value is unquoted and contains
    // problematic YAML characters (colons followed by space, or starts
    // with special chars like {, [, >, |, *, &, !, %, @, `)
    const kvMatch = line.match(/^(\s*[\w-]+):\s+(.+)$/);
    if (!kvMatch) return line;

    const [, key, value] = kvMatch;
    // Already quoted
    if (/^["'].*["']$/.test(value)) return line;
    // Multi-line scalar indicators
    if (/^[|>]/.test(value)) return line;

    // Needs quoting if value contains: colon-space, or starts with special YAML chars
    const needsQuoting =
      /: /.test(value) ||           // colon-space (nested mapping ambiguity)
      /^[{[*&!%@`]/.test(value) ||  // YAML special characters at start
      /^['"]/.test(value) ||         // starts with quote but doesn't end with one (mismatched)
      /#/.test(value);               // contains comment character

    if (needsQuoting) {
      // Escape existing double quotes in value, wrap in double quotes
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    }

    return line;
  });
}

export const frontmatterFixer: Fixer = {
  artifactType: "skill-md",

  fix(_filePath: string, content: string, _config: LinterConfig): string {
    let result = content;

    // Fix trailing whitespace on each line
    result = result.replace(/[ \t]+$/gm, "");

    // Ensure trailing newline
    if (!result.endsWith("\n")) {
      result += "\n";
    }

    // Parse and reformat frontmatter
    const lines = result.split("\n");
    if (lines[0]?.trim() !== "---") return result;

    let closingIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        closingIndex = i;
        break;
      }
    }
    if (closingIndex === -1) return result;

    const fmRaw = lines.slice(1, closingIndex);
    const body = lines.slice(closingIndex + 1).join("\n");

    // Pre-parse fix: quote values with problematic YAML characters
    const fixedFmLines = preParseFixFrontmatter(fmRaw);
    const fixedFmRaw = fixedFmLines.join("\n");

    let data: Record<string, unknown>;
    try {
      data = parseYaml(fixedFmRaw);
      if (typeof data !== "object" || data === null || Array.isArray(data)) return result;
    } catch {
      return result; // still can't parse even after pre-fix
    }

    // Normalize name to kebab-case
    if (typeof data.name === "string" && !isKebabCase(data.name)) {
      data.name = toKebabCase(data.name);
    }

    // Re-serialize frontmatter
    const newFm = stringifyYaml(data, { lineWidth: 0, defaultStringType: "PLAIN" }).trimEnd();

    return `---\n${newFm}\n---\n${body}`;
  },
};
