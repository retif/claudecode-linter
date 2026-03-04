import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Fixer, LinterConfig } from "../types.js";
import { toKebabCase, isKebabCase } from "../utils/kebab-case.js";

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

    const fmRaw = lines.slice(1, closingIndex).join("\n");
    const body = lines.slice(closingIndex + 1).join("\n");

    let data: Record<string, unknown>;
    try {
      data = parseYaml(fmRaw);
      if (typeof data !== "object" || data === null || Array.isArray(data)) return result;
    } catch {
      return result; // can't fix unparseable YAML
    }

    // Normalize name to kebab-case
    if (typeof data.name === "string" && !isKebabCase(data.name)) {
      data.name = toKebabCase(data.name);
    }

    // Re-serialize frontmatter
    const newFm = stringifyYaml(data, { lineWidth: 0, defaultStringType: "PLAIN" }).trimEnd();

    return `---\n${newFm}\n---${body}`;
  },
};
