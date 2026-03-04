import type { Fixer, LinterConfig } from "../types.js";

export const hooksJsonFixer: Fixer = {
  artifactType: "hooks-json",

  fix(_filePath: string, content: string, _config: LinterConfig): string {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return content;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return content;
    }

    // Sort hooks object keys (event names) alphabetically
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).sort()) {
      ordered[key] = parsed[key];
    }

    return JSON.stringify(ordered, null, 2) + "\n";
  },
};
