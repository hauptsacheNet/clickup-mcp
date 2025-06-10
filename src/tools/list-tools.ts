import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { ContentBlock } from "../shared/types";

export function registerListTools(server: McpServer) {
  server.tool(
    "listLists",
    "Lists all lists and folders in a space. Shows both direct lists (folderless) and folders containing lists. If folder_id is provided, lists only the lists within that specific folder.",
    {
      space_id: z.string().min(1).describe("The ID of the space to list content from"),
      folder_id: z.string().optional().describe("Optional folder ID. If provided, lists only lists within this folder. If not provided, shows both folders and folderless lists in the space."),
      archived: z.boolean().optional().describe("Include archived items (default: false)")
    },
    async ({ space_id, folder_id, archived = false }) => {
      try {
        if (folder_id) {
          // List lists within a specific folder
          const url = `https://api.clickup.com/api/v2/folder/${folder_id}/list${archived ? '?archived=true' : ''}`;
          const response = await fetch(url, {
            headers: { Authorization: CONFIG.apiKey },
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`API Error: ${response.status} ${response.statusText}`, errorText);
            throw new Error(`Error fetching lists in folder ${folder_id}: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          
          if (!data.lists || !Array.isArray(data.lists)) {
            return {
              content: [{ type: "text", text: `No lists found in folder ${folder_id}.` }],
            };
          }

          const listBlocks: ContentBlock[] = data.lists.map((list: any) => ({
            type: "text" as const,
            text: [
              `type: list`,
              `list_id: ${list.id}`,
              `name: ${list.name}`,
              `space_id: ${list.space?.id || space_id}`,
              `folder_id: ${folder_id}`,
              `task_count: ${list.task_count || 0}`,
              `private: ${list.private || false}`,
              ...(list.archived ? ['archived: true'] : []),
              ...(list.color ? [`color: ${list.color}`] : []),
              ...(list.access ? [`access: ${list.access}`] : []),
            ].join('\n')
          }));

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${data.lists.length} list(s) in folder ${folder_id}:`
              },
              ...listBlocks
            ],
          };
        } else {
          // List both folders and folderless lists in the space (parallel requests)
          const archiveQuery = archived ? '?archived=true' : '';
          const [foldersResponse, listsResponse] = await Promise.all([
            fetch(`https://api.clickup.com/api/v2/space/${space_id}/folder${archiveQuery}`, {
              headers: { Authorization: CONFIG.apiKey },
            }),
            fetch(`https://api.clickup.com/api/v2/space/${space_id}/list${archiveQuery}`, {
              headers: { Authorization: CONFIG.apiKey },
            })
          ]);

          const results: ContentBlock[] = [];
          let totalItems = 0;

          // Process folders
          if (foldersResponse.ok) {
            const foldersData = await foldersResponse.json();
            if (foldersData.folders && Array.isArray(foldersData.folders)) {
              const folderBlocks: ContentBlock[] = foldersData.folders.map((folder: any) => ({
                type: "text" as const,
                text: [
                  `type: folder`,
                  `folder_id: ${folder.id}`,
                  `name: ${folder.name}`,
                  `space_id: ${space_id}`,
                  `task_count: ${folder.task_count || 0}`,
                  `private: ${folder.private || false}`,
                  ...(folder.archived ? ['archived: true'] : []),
                  ...(folder.color ? [`color: ${folder.color}`] : []),
                  `contains_lists: true`
                ].join('\n')
              }));
              results.push(...folderBlocks);
              totalItems += foldersData.folders.length;
            }
          } else {
            console.warn(`Failed to fetch folders: ${foldersResponse.status} ${foldersResponse.statusText}`);
          }

          // Process folderless lists
          if (listsResponse.ok) {
            const listsData = await listsResponse.json();
            if (listsData.lists && Array.isArray(listsData.lists)) {
              const listBlocks: ContentBlock[] = listsData.lists.map((list: any) => ({
                type: "text" as const,
                text: [
                  `type: list`,
                  `list_id: ${list.id}`,
                  `name: ${list.name}`,
                  `space_id: ${list.space?.id || space_id}`,
                  `task_count: ${list.task_count || 0}`,
                  `private: ${list.private || false}`,
                  ...(list.archived ? ['archived: true'] : []),
                  ...(list.color ? [`color: ${list.color}`] : []),
                  ...(list.access ? [`access: ${list.access}`] : []),
                ].join('\n')
              }));
              results.push(...listBlocks);
              totalItems += listsData.lists.length;
            }
          } else {
            console.warn(`Failed to fetch lists: ${listsResponse.status} ${listsResponse.statusText}`);
          }

          if (totalItems === 0) {
            return {
              content: [{ type: "text", text: `No folders or lists found in space ${space_id}.` }],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${totalItems} item(s) in space ${space_id} (folders and lists):`
              },
              ...results
            ],
          };
        }

      } catch (error) {
        console.error('Error fetching space content:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching space content: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}