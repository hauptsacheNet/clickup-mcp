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
import { registerListToolsRead, registerListToolsWrite, registerFolderToolsRead } from "./tools/list-tools";
import { registerTimeToolsRead, registerTimeToolsWrite } from "./tools/time-tools";
import { registerDocumentToolsRead, registerDocumentToolsWrite } from "./tools/doc-tools";
import { registerSpaceResources } from "./resources/space-resources";

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

  // Register prompts
  const lang = CONFIG.primaryLanguageHint === 'de' ? 'de' : 'en';
  
  // Register "my-todos" prompt
  server.registerPrompt(
    "my-todos",
    {
      title: lang === 'de' ? "Meine TODOs" : "My TODOs",
      description: lang === 'de'
        ? "Meine aktuellen TODO-Aufgaben aus ClickUp abrufen und nach Priorität kategorisiert analysieren"
        : "Get and analyze my current TODO tasks from ClickUp, categorized by priority"
    },
    () => {
      const messages = [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: lang === 'de' 
            ? `Kannst du in ClickUp nachsehen, was meine aktuellen TODOs sind? Bitte suche nach allen offenen Aufgaben, die mir zugewiesen sind, analysiere deren Inhalt und kategorisiere sie nach erkennbarer Priorität (dringend, hoch, normal, niedrig). Für jede Kategorie gib eine kurze Zusammenfassung dessen, was getan werden muss und hebe Fälligkeitstermine oder wichtige Details aus den Aufgabenbeschreibungen hervor.

Bitte strukturiere deine Antwort mit:
1. **Zusammenfassung**: Gesamtanzahl der Aufgaben und allgemeine Prioritätsverteilung
2. **Dringende Aufgaben**: Aufgaben, die sofortige Aufmerksamkeit benötigen (heute fällig, überfällig oder als dringend markiert)
3. **Hohe Priorität**: Wichtige Aufgaben, die bald erledigt werden sollten
4. **Normale Priorität**: Regelmäßige Aufgaben, die später geplant werden können
5. **Niedrige Priorität**: Aufgaben, die erledigt werden können, wenn Zeit vorhanden ist
6. **Empfehlungen**: Vorgeschlagene Maßnahmen oder Prioritäten für den kommenden Zeitraum

Verwende die ClickUp-Suchtools, um mir zugewiesene Aufgaben zu finden, und hole detaillierte Informationen über die wichtigsten mit getTaskById.`
            : `Can you look into ClickUp and check what my current TODO's are? Please search for all open tasks assigned to me, analyze their content, and categorize them by apparent priority (urgent, high, normal, low). For each category, provide a brief summary of what needs to be done and highlight any due dates or important details from the task descriptions.

Please structure your response with:
1. **Summary**: Total number of tasks and overall priority distribution
2. **Urgent Tasks**: Tasks that need immediate attention (due today, overdue, or marked as urgent)
3. **High Priority**: Important tasks that should be addressed soon
4. **Normal Priority**: Regular tasks that can be scheduled for later
5. **Low Priority**: Tasks that can be done when time permits
6. **Recommendations**: Suggested actions or priorities for the upcoming period

Use the ClickUp search tools to find tasks assigned to me, and get detailed information about the most important ones using getTaskById.`
        }
      }];
      return { messages };
    }
  );

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
    registerSpaceResources(server);
    registerListToolsRead(server);
    registerFolderToolsRead(server);
    registerTimeToolsRead(server);
    registerDocumentToolsRead(server);
  } else if (CONFIG.mode === 'write') {
    // All tools (full functionality)
    registerTaskToolsRead(server, userData);
    registerTaskToolsWrite(server, userData);
    registerSearchTools(server, userData);
    registerSpaceTools(server);
    registerSpaceResources(server);
    registerListToolsRead(server);
    registerListToolsWrite(server);
    registerFolderToolsRead(server);
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
// OR if not being imported by CLI (to support Claude Desktop's module loading)
const isCliMode = process.argv.some(arg => arg.includes('cli.ts') || arg.includes('cli.js'));
if (require.main === module || !isCliMode) {
  // Start receiving messages on stdin and sending messages on stdout after initialization
  serverPromise.then(() => {
    const transport = new StdioServerTransport();
    server.connect(transport);
  }).catch(console.error);
}