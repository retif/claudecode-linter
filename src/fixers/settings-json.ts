import type { Fixer, LinterConfig } from "../types.js";
import { formatJson } from "../utils/prettier.js";

const TOP_LEVEL_KEY_ORDER = [
  "permissions",
  "sandbox",
  "hooks",
  "env",
  "plugins",
  "skipDangerousModePermissionPrompt",
];

export const settingsJsonFixer: Fixer = {
  artifactType: "settings-json",

  async fix(_filePath: string, content: string, _config: LinterConfig): Promise<string> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return content;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return content;
    }

    // Sort top-level keys in canonical order, then remaining alphabetically
    const ordered: Record<string, unknown> = {};
    for (const key of TOP_LEVEL_KEY_ORDER) {
      if (key in parsed) {
        ordered[key] = parsed[key];
      }
    }
    for (const key of Object.keys(parsed).sort()) {
      if (!(key in ordered)) {
        ordered[key] = parsed[key];
      }
    }

    // Sort the permissions.allow / deny / ask rule arrays alphabetically
    const permissions = ordered["permissions"];
    if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
      const perms = permissions as Record<string, unknown>;
      for (const list of ["allow", "deny", "ask"]) {
        if (Array.isArray(perms[list])) {
          perms[list] = [...(perms[list] as string[])].sort();
        }
      }
    }

    return formatJson(JSON.stringify(ordered));
  },
};
