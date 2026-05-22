import { parse as parseYaml } from "yaml";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  frontmatterRaw: string;
  bodyStartLine: number;
  valid: boolean;
  error?: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return {
      data: {},
      body: content,
      frontmatterRaw: "",
      bodyStartLine: 1,
      valid: false,
      error: "File does not start with '---' frontmatter delimiter",
    };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return {
      data: {},
      body: content,
      frontmatterRaw: "",
      bodyStartLine: 1,
      valid: false,
      error: "No closing '---' frontmatter delimiter found",
    };
  }

  const frontmatterRaw = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  const bodyStartLine = closingIndex + 2; // 1-based

  try {
    const data = parseYaml(frontmatterRaw, { maxAliasCount: 100 });
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return {
        data: {},
        body,
        frontmatterRaw,
        bodyStartLine,
        valid: false,
        error: "Frontmatter YAML must be a mapping (key-value pairs)",
      };
    }
    return {
      data: data as Record<string, unknown>,
      body,
      frontmatterRaw,
      bodyStartLine,
      valid: true,
    };
  } catch (e) {
    return {
      data: {},
      body,
      frontmatterRaw,
      bodyStartLine,
      valid: false,
      error: `Invalid YAML in frontmatter: ${(e as Error).message}`,
    };
  }
}
