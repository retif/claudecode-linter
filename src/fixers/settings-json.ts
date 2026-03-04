import type { Fixer, LinterConfig } from "../types.js";

const TOP_LEVEL_KEY_ORDER = [
  "permissions",
  "env",
  "plugins",
  "skipDangerousModePermissionPrompt",
];

export const settingsJsonFixer: Fixer = {
  artifactType: "settings-json",

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

    // Sort permissions.allow and permissions.deny alphabetically
    const permissions = ordered["permissions"];
    if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
      const perms = permissions as Record<string, unknown>;
      if (Array.isArray(perms["allow"])) {
        perms["allow"] = [...(perms["allow"] as string[])].sort();
      }
      if (Array.isArray(perms["deny"])) {
        perms["deny"] = [...(perms["deny"] as string[])].sort();
      }
    }

    return JSON.stringify(ordered, null, 2) + "\n";
  },
};
