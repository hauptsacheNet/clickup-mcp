import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { ContentBlock } from "../shared/types";
import { generateSpaceUrl } from "../shared/utils";

export function registerSpaceTools(server: McpServer) {
  server.tool(
    "listSpaces",
    [
      "Lists all spaces in the workspace. These might also be referred to as customers or projects.",
      "Always reference spaces by their URLs when discussing projects or suggesting actions."
    ].join("\n"),
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
            `space_url: ${generateSpaceUrl(space.id)}`,
            `name: ${space.name}`,
            ...(space.private ? [`private: true`] : []),
            ...(space.archived ? ['archived: true'] : []),
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
}