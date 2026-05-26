import type { Fixer, LinterConfig } from "../types.js";
import { formatJson } from "../utils/prettier.js";

const SERVER_FIELD_ORDER = ["type", "command", "url", "args", "env"];

export const mcpJsonFixer: Fixer = {
  artifactType: "mcp-json",

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
          // gitea#7: URL-based servers with type:"http" rewrite to
          // "streamable-http" (the runtime transport is identical post-v2.1.146;
          // the rename avoids the legacy OAuth-probe code path).
          if (orderedServer.type === "http" && typeof orderedServer.url === "string") {
            orderedServer.type = "streamable-http";
          }
          sortedServers[serverName] = orderedServer;
        } else {
          sortedServers[serverName] = server;
        }
      }

      result["mcpServers"] = sortedServers;
    }

    return formatJson(JSON.stringify(result));
  },
};
