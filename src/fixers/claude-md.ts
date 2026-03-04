import type { Fixer, LinterConfig } from "../types.js";

export const claudeMdFixer: Fixer = {
  artifactType: "claude-md",

  fix(_filePath: string, content: string, _config: LinterConfig): string {
    if (content === "") return content;

    // Strip trailing whitespace from all lines
    let result = content.replace(/[ \t]+$/gm, "");

    // Ensure file ends with exactly one newline
    result = result.replace(/\n*$/, "\n");

    // Ensure blank line before headings unless it's the first line
    const lines = result.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && line.startsWith("#") && i > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      if (line !== undefined) {
        out.push(line);
      }
    }
    return out.join("\n");
  },
};
