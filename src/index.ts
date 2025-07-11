#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "./shared/config";
import {getCurrentUser, getSpaceSearchIndex} from "./shared/utils";

// Import tool registration functions
import { registerTaskToolsRead } from "./tools/task-tools";
import { registerTaskToolsWrite } from "./tools/task-write-tools";
import { registerSearchTools } from "./tools/search-tools";
import { registerSpaceTools } from "./tools/space-tools";
import { registerListToolsRead, registerListToolsWrite } from "./tools/list-tools";
import { registerTimeToolsRead, registerTimeToolsWrite } from "./tools/time-tools";
import { registerDocumentToolsRead, registerDocumentToolsWrite } from "./tools/doc-tools";

// Create server variable that will be initialized later
let server: McpServer;

// Register tools based on mode with user data for enhanced documentation
async function initializeServer() {
  console.error(`Starting ClickUp MCP in ${CONFIG.mode} mode`);

  // Fetch current user and spaces for enhanced tool documentation and API health check
  const [userData, spacesIndex] = await Promise.all([
    getCurrentUser(),
    getSpaceSearchIndex()
  ]);
  const spaces = (spacesIndex as any)._docs || [];
  console.error(`Connected as: ${userData.user.username} (${userData.user.email})`);

  // Filter out archived spaces and format as simple list
  const activeSpaces = spaces.filter((s: any) => !s.archived);
  const formattedSpaces = activeSpaces
    .map((s: any) => `- ${s.name} (space_id: ${s.id})`)
    .join('\n');
  
  const instructions = [
    `ClickUp is a Ticket system. It is used to track tasks, bugs, and other work items.`,
    `Is you are asked for infos about projects or tasks, search for tasks or documents in ClickUp (this MCP) first.`,
    `The following spaces/projects are available:`,
    formattedSpaces
  ].join('\n');
  console.error(`Pre-loaded ${activeSpaces.length} active spaces`);
  
  // Create the MCP server with instructions
  server = new McpServer({
    name: "Clickup MCP",
    version: require('../package.json').version,
  }, {
    instructions
  });

  if (CONFIG.mode === 'read-minimal') {
    // Core task context tools for AI coding assistance
    // Only getTaskById and searchTasks
    registerTaskToolsRead(server, userData);
    registerSearchTools(server, userData);
  } else if (CONFIG.mode === 'read') {
    // All read-only tools
    registerTaskToolsRead(server, userData);
    registerSearchTools(server, userData);
    registerSpaceTools(server);
    registerListToolsRead(server);
    registerTimeToolsRead(server);
    registerDocumentToolsRead(server);
  } else if (CONFIG.mode === 'write') {
    // All tools (full functionality)
    registerTaskToolsRead(server, userData);
    registerTaskToolsWrite(server, userData);
    registerSearchTools(server, userData);
    registerSpaceTools(server);
    registerListToolsRead(server);
    registerListToolsWrite(server);
    registerTimeToolsRead(server);
    registerTimeToolsWrite(server);
    registerDocumentToolsRead(server);
    registerDocumentToolsWrite(server);
  }

  return server;
}

// Initialize server with enhanced documentation and export
const serverPromise = initializeServer();

// Export the server promise for CLI and main usage
// Note: server is created inside the promise, so we export a getter
export { serverPromise };

// Only connect to the transport if this file is being run directly (not imported)
if (require.main === module) {
  // Start receiving messages on stdin and sending messages on stdout after initialization
  serverPromise.then(() => {
    const transport = new StdioServerTransport();
    server.connect(transport);
  }).catch(console.error);
}