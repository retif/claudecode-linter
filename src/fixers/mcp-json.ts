import type { Fixer, LinterConfig } from "../types.js";

const SERVER_FIELD_ORDER = ["type", "command", "url", "args", "env"];

export const mcpJsonFixer: Fixer = {
  artifactType: "mcp-json",

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

    const result: Record<string, unknown> = { ...parsed };

    const mcpServers = parsed["mcpServers"];
    if (typeof mcpServers === "object" && mcpServers !== null && !Array.isArray(mcpServers)) {
      const servers = mcpServers as Record<string, unknown>;
      const sortedServers: Record<string, unknown> = {};

      for (const serverName of Object.keys(servers).sort()) {
        const server = servers[serverName];
        if (typeof server === "object" && server !== null && !Array.isArray(server)) {
          const serverObj = server as Record<string, unknown>;
          const orderedServer: Record<string, unknown> = {};
          for (const field of SERVER_FIELD_ORDER) {
            if (field in serverObj) {
              orderedServer[field] = serverObj[field];
            }
          }
          for (const field of Object.keys(serverObj).sort()) {
            if (!(field in orderedServer)) {
              orderedServer[field] = serverObj[field];
            }
          }
          sortedServers[serverName] = orderedServer;
        } else {
          sortedServers[serverName] = server;
        }
      }

      result["mcpServers"] = sortedServers;
    }

    return JSON.stringify(result, null, 2) + "\n";
  },
};
