#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "./shared/config";
import { getCurrentUser } from "./shared/utils";

// Import tool registration functions
import { registerTaskToolsRead, registerTaskToolsWrite } from "./tools/task-tools";
import { registerSearchTools } from "./tools/search-tools";
import { registerSpaceTools } from "./tools/space-tools";
import { registerListTools } from "./tools/list-tools";
import { registerTimeToolsRead, registerTimeToolsWrite } from "./tools/time-tools";

// Create an MCP server
const server = new McpServer({
  name: "Clickup MCP",
  version: "1.0.0",
});

// Register tools based on mode with user data for enhanced documentation
async function initializeServer() {
  console.error(`Starting ClickUp MCP in ${CONFIG.mode} mode`);

  // Fetch current user for enhanced tool documentation and API health check
  const userData = await getCurrentUser();
  console.error(`Connected as: ${userData.user.username} (${userData.user.email})`);

  if (CONFIG.mode === 'read-minimal') {
    // Core task context tools for AI coding assistance
    // Only getTaskById and searchTasks
    registerTaskToolsRead(server, userData);
    registerSearchTools(server);
  } else if (CONFIG.mode === 'read') {
    // All read-only tools
    registerTaskToolsRead(server, userData);
    registerSearchTools(server);
    registerSpaceTools(server);
    registerListTools(server);
    registerTimeToolsRead(server);
  } else if (CONFIG.mode === 'write') {
    // All tools (full functionality)
    registerTaskToolsRead(server, userData);
    registerTaskToolsWrite(server, userData);
    registerSearchTools(server);
    registerSpaceTools(server);
    registerListTools(server);
    registerTimeToolsRead(server);
    registerTimeToolsWrite(server);
  }

  return server;
}

// Initialize server with enhanced documentation and export
const serverPromise = initializeServer();

// Export the server for CLI and main usage
export { server, serverPromise };

// Only connect to the transport if this file is being run directly (not imported)
if (require.main === module) {
  // Start receiving messages on stdin and sending messages on stdout after initialization
  serverPromise.then(() => {
    const transport = new StdioServerTransport();
    server.connect(transport);
  }).catch(console.error);
}