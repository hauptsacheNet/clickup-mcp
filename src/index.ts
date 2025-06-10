#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import tool registration functions
import { registerTaskTools } from "./tools/task-tools";
import { registerSpaceTools } from "./tools/space-tools";
import { registerListTools } from "./tools/list-tools";
import { registerTimeTools } from "./tools/time-tools";
import { registerCreateTools } from "./tools/create-tools";

// Create an MCP server
export const server = new McpServer({
  name: "Clickup MCP",
  version: "1.0.0",
});

// Register all tools
registerTaskTools(server);
registerSpaceTools(server);
registerListTools(server);
registerTimeTools(server);
registerCreateTools(server);

// Only connect to the transport if this file is being run directly (not imported)
if (require.main === module) {
  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  server.connect(transport);
}