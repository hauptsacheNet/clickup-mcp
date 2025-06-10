import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { ContentBlock } from "../shared/types";

export function registerSpaceTools(server: McpServer) {
  server.tool(
    "listSpaces", 
    "Lists all spaces in the workspace with pagination support for large workspaces",
    {
      archived: z.boolean().optional().describe("Include archived spaces (default: false)")
    },
    async ({ archived = false }) => {
      try {
        const url = `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/space${archived ? '?archived=true' : ''}`;
        const response = await fetch(url, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!response.ok) {
          throw new Error(`Error fetching spaces: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        if (!data.spaces || !Array.isArray(data.spaces)) {
          return {
            content: [{ type: "text", text: "No spaces found in the workspace." }],
          };
        }

        const spaceBlocks: ContentBlock[] = data.spaces.map((space: any) => ({
          type: "text" as const,
          text: [
            `space_id: ${space.id}`,
            `name: ${space.name}`,
            `private: ${space.private || false}`,
            `avatar: ${space.avatar || 'None'}`,
            `color: ${space.color || 'None'}`,
            `access: ${space.access || 'Unknown'}`,
            ...(space.archived ? ['archived: true'] : []),
            ...(space.multiple_assignees !== undefined ? [`multiple_assignees: ${space.multiple_assignees}`] : []),
            ...(space.features?.due_dates?.enabled !== undefined ? [`due_dates_enabled: ${space.features.due_dates.enabled}`] : []),
            ...(space.features?.time_tracking?.enabled !== undefined ? [`time_tracking_enabled: ${space.features.time_tracking.enabled}`] : []),
          ].join('\n')
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.spaces.length} space(s) in the workspace:`
            },
            ...spaceBlocks
          ],
        };

      } catch (error) {
        console.error('Error fetching spaces:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching spaces: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  // listFolders tool removed - now integrated into listLists tool in list-tools.ts
}