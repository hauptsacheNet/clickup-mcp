import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { ContentBlock } from "../shared/types";
import { generateListUrl, generateSpaceUrl, generateFolderUrl, formatListLink, formatSpaceLink } from "../shared/utils";

export function registerListToolsRead(server: McpServer) {
  server.tool(
    "listLists",
    [
      "Lists all lists and folders in a space. They might also be referred to as boards or tables.",
      "Shows both direct lists (folderless) and folders containing lists. If folder_id is provided, lists only the lists within that specific folder.",
      "Always reference lists by their URLs when suggesting actions or creating tasks."
    ].join("\n"),
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
              `list_url: ${generateListUrl(list.id)}`,
              `name: ${list.name}`,
              `space_id: ${list.space?.id || space_id}`,
              `folder_id: ${folder_id}`,
              `task_count: ${list.task_count || 0}`,
              ...(list.private ? [`private: true`] : []),
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
                  `folder_url: ${generateFolderUrl(folder.id)}`,
                  `name: ${folder.name}`,
                  `space_id: ${space_id}`,
                  `task_count: ${folder.task_count || 0}`,
                  ...(folder.private ? [`private: true`] : []),
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
                  `list_url: ${generateListUrl(list.id)}`,
                  `name: ${list.name}`,
                  `space_id: ${list.space?.id || space_id}`,
                  `task_count: ${list.task_count || 0}`,
                  ...(list.private ? [`private: true`] : []),
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

  server.tool(
    "getListInfo",
    [
      "Gets comprehensive information about a list including description and available statuses.",
      "ALWAYS use the list URL (https://app.clickup.com/v/l/LIST_ID) when referencing lists.",
      "Use this before creating tasks to understand the list context and available statuses for new tasks.",
      "IMPORTANT: The list description often contains valuable project context, requirements, or guidelines - read and consider this information when creating or updating tasks in this list.",
      "Share the clickable list URL when suggesting list-related actions."
    ].join("\n"),
    {
      list_id: z.string().min(1).describe("The list ID to get information for")
    },
    async ({ list_id }) => {
      try {
        // Get list details including statuses (try to get markdown content)
        const listResponse = await fetch(`https://api.clickup.com/api/v2/list/${list_id}?include_markdown_description=true`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!listResponse.ok) {
          throw new Error(`Error fetching list details: ${listResponse.status} ${listResponse.statusText}`);
        }

        const listData = await listResponse.json();

        // Fetch space tags in parallel (don't let this fail the main request)
        let spaceTags: any[] = [];
        if (listData.space?.id) {
          try {
            const spaceTagsResponse = await fetch(`https://api.clickup.com/api/v2/space/${listData.space.id}/tag`, {
              headers: { Authorization: CONFIG.apiKey },
            });
            if (spaceTagsResponse.ok) {
              const spaceTagsData = await spaceTagsResponse.json();
              spaceTags = spaceTagsData.tags || [];
            }
          } catch (error) {
            console.error(`Error fetching space tags for space ${listData.space.id}:`, error);
          }
        }

        const responseLines = [
          `List Information:`,
          `list_id: ${list_id}`,
          `list_url: ${generateListUrl(list_id)}`,
          `name: ${listData.name}`,
          `folder: ${listData.folder?.name || 'No folder'}`,
          `space: ${listData.space?.name || 'Unknown'} (${listData.space?.id || 'N/A'})`,
          `space_url: ${generateSpaceUrl(listData.space?.id || '')}`,
          `archived: ${listData.archived || false}`,
          `task_count: ${listData.task_count || 0}`,
        ];

        // Add description if available (check both content and markdown fields)
        const description = listData.markdown_description || listData.markdown_content || listData.content;
        if (description) {
          responseLines.push(`description: ${description}`);
        }

        // Add available statuses
        if (listData.statuses && Array.isArray(listData.statuses)) {
          const statuses = listData.statuses.map((status: any) => ({
            name: status.status,
            color: status.color || 'none',
            type: status.type || 'custom'
          }));

          responseLines.push(`Available statuses (${statuses.length} total):`);

          statuses.forEach((status: any) => {
            responseLines.push(`  - ${status.name} (${status.type})`);
          });

          responseLines.push(`Valid status names for createTask/updateTask: ${statuses.map((s: any) => s.name).join(', ')}`);
        } else {
          responseLines.push('No statuses found for this list.');
        }

        // Add space tags information
        if (spaceTags.length > 0) {
          const tagNames = spaceTags.map((tag: any) => tag.name).filter(Boolean).sort();
          if (tagNames.length > 0) {
            responseLines.push(`Available tags in space (shared across all lists): ${tagNames.join(', ')}`);
          }
        } else if (listData.space?.id) {
          responseLines.push('No tags found in this space.');
        }

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error getting list info:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error getting list info: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

export function registerListToolsWrite(server: McpServer) {
  server.tool(
    "updateListInfo",
    [
      "Appends documentation or context to a list's description.",
      "ALWAYS reference the list URL (https://app.clickup.com/v/l/LIST_ID) when updating or discussing lists.",
      "SAFETY FEATURE: Description updates are APPEND-ONLY to prevent data loss - existing content is preserved.",
      "Use this to add project context, requirements, or guidelines that LLMs should consider when working with tasks in this list.",
      "Include links to related tasks, spaces, or external resources in the appended content.",
      "Content is appended in markdown format with timestamp for tracking changes."
    ].join("\n"),
    {
      list_id: z.string().min(1).describe("The list ID to update"),
      append_description: z.string().min(1).describe("Markdown content to APPEND to existing list description (preserves existing content for safety)")
    },
    async ({ list_id, append_description }) => {
      try {
        // Get current list info including description (try to get markdown content)
        const listResponse = await fetch(`https://api.clickup.com/api/v2/list/${list_id}?include_markdown_description=true`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!listResponse.ok) {
          throw new Error(`Error fetching list: ${listResponse.status} ${listResponse.statusText}`);
        }

        const listData = await listResponse.json();

        // Handle append-only description update with markdown support
        const currentDescription = listData.markdown_description || listData.markdown_content || listData.content || "";
        const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        const separator = currentDescription.trim() ? "\n\n---\n" : "";
        const finalDescription = currentDescription + separator + `**Edit (${timestamp}):** ${append_description}`;

        // Update the list description using markdown_content
        const updateResponse = await fetch(`https://api.clickup.com/api/v2/list/${list_id}`, {
          method: 'PUT',
          headers: {
            Authorization: CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            markdown_content: finalDescription
          })
        });

        if (!updateResponse.ok) {
          const errorData = await updateResponse.json().catch(() => ({}));
          throw new Error(`Error updating list: ${updateResponse.status} ${updateResponse.statusText} - ${JSON.stringify(errorData)}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully appended content to list "${listData.name}". The new content has been added with timestamp (${timestamp}) while preserving existing description.`,
            },
          ],
        };

      } catch (error) {
        console.error('Error updating list info:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating list info: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}