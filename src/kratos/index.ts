import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListByStatusTool } from "./list-by-status";
import { LIST_TASKS_BY_STATUS_TOOL } from "./settings";

export const KRATOS_TOOLS = [LIST_TASKS_BY_STATUS_TOOL] as const;

export function registerKratosToolsRead(server: McpServer) {
  registerListByStatusTool(server);
}

// Upstream calls this in write mode only; our write tools join here when they exist.
export function registerKratosToolsWrite(_server: McpServer) {}
