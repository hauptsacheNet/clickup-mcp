import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import {
  generateListUrl,
  generateSpaceUrl,
  generateFolderUrl,
  getFolderDetails,
} from "../shared/utils";

export function registerListToolsRead(server: McpServer) {
  server.tool(
    "getListInfo",
    [
      "Gets comprehensive information about a list including description and available statuses.",
      "ALWAYS use the list URL (https://app.clickup.com/v/l/LIST_ID) when referencing lists.",
      "Use this before creating tasks to understand the list context and available statuses for new tasks.",
      "IMPORTANT: The list description often contains valuable project context, requirements, or guidelines - read and consider this information when creating or updating tasks in this list.",
      "Share the clickable list URL when suggesting list-related actions.",
    ].join("\n"),
    {
      list_id: z.string().min(1).describe("The list ID to get information for"),
    },
    {
      readOnlyHint: true,
    },
    async ({ list_id }) => {
      try {
        // Get list details including statuses (try to get markdown content)
        const listResponse = await fetch(
          `https://api.clickup.com/api/v2/list/${list_id}?include_markdown_description=true`,
          {
            headers: { Authorization: CONFIG.apiKey },
          },
        );

        if (!listResponse.ok) {
          throw new Error(
            `Error fetching list details: ${listResponse.status} ${listResponse.statusText}`,
          );
        }

        const listData = await listResponse.json();

        // Fetch space tags in parallel (don't let this fail the main request)
        let spaceTags: any[] = [];
        if (listData.space?.id) {
          try {
            const spaceTagsResponse = await fetch(
              `https://api.clickup.com/api/v2/space/${listData.space.id}/tag`,
              {
                headers: { Authorization: CONFIG.apiKey },
              },
            );
            if (spaceTagsResponse.ok) {
              const spaceTagsData = await spaceTagsResponse.json();
              spaceTags = spaceTagsData.tags || [];
            }
          } catch (error) {
            console.error(
              `Error fetching space tags for space ${listData.space.id}:`,
              error,
            );
          }
        }

        const responseLines = [
          `List Information:`,
          `list_id: ${list_id}`,
          `list_url: ${generateListUrl(list_id)}`,
          `name: ${listData.name}`,
          `folder: ${listData.folder?.name || "No folder"}`,
          `space: ${listData.space?.name || "Unknown"} (${listData.space?.id || "N/A"})`,
          `space_url: ${generateSpaceUrl(listData.space?.id || "")}`,
          `archived: ${listData.archived || false}`,
          `task_count: ${listData.task_count || 0}`,
        ];

        // Add description if available (check both content and markdown fields)
        const description =
          listData.markdown_description ||
          listData.markdown_content ||
          listData.content;
        if (description) {
          responseLines.push(`description: ${description}`);
        }

        // Add available statuses
        if (listData.statuses && Array.isArray(listData.statuses)) {
          const statuses = listData.statuses.map((status: any) => ({
            name: status.status,
            color: status.color || "none",
            type: status.type || "custom",
          }));

          responseLines.push(`Available statuses (${statuses.length} total):`);

          statuses.forEach((status: any) => {
            responseLines.push(`  - ${status.name} (${status.type})`);
          });

          responseLines.push(
            `Valid status names for createTask/updateTask: ${statuses.map((s: any) => s.name).join(", ")}`,
          );
        } else {
          responseLines.push("No statuses found for this list.");
        }

        // Add space tags information
        if (spaceTags.length > 0) {
          const tagNames = spaceTags
            .map((tag: any) => tag.name)
            .filter(Boolean)
            .sort();
          if (tagNames.length > 0) {
            responseLines.push(
              `Available tags in space (shared across all lists): ${tagNames.join(", ")}`,
            );
          }
        } else if (listData.space?.id) {
          responseLines.push("No tags found in this space.");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join("\n"),
            },
          ],
        };
      } catch (error) {
        console.error("Error getting list info:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error getting list info: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    },
  );
}

export function registerFolderToolsRead(server: McpServer) {
  server.tool(
    "getFolderInfo",
    [
      "Gets information about a ClickUp folder including its lists, parent space, and metadata.",
      "ALWAYS use the folder URL (https://app.clickup.com/TEAM_ID/v/f/FOLDER_ID) when referencing folders.",
      "Use this to discover lists inside a folder or understand folder structure.",
      "Share the clickable folder URL when suggesting folder-related actions.",
    ].join("\n"),
    {
      folder_id: z
        .string()
        .min(1)
        .describe("The folder ID to get information for"),
    },
    {
      readOnlyHint: true,
    },
    async ({ folder_id }) => {
      try {
        const folderData = await getFolderDetails(folder_id);

        const responseLines = [
          `Folder Information:`,
          `folder_id: ${folder_id}`,
          `folder_url: ${generateFolderUrl(folder_id)}`,
          `name: ${folderData.name}`,
          `space: ${folderData.space?.name || "Unknown"} (space_id: ${folderData.space?.id || "N/A"})`,
          `space_url: ${generateSpaceUrl(folderData.space?.id || "")}`,
          `archived: ${folderData.archived || false}`,
          `hidden: ${folderData.hidden || false}`,
        ];

        // Add lists contained in this folder
        if (
          folderData.lists &&
          Array.isArray(folderData.lists) &&
          folderData.lists.length > 0
        ) {
          responseLines.push(
            `Lists in this folder (${folderData.lists.length} total):`,
          );
          folderData.lists.forEach((list: any) => {
            const extraInfo = [
              ...(list.task_count ? [`${list.task_count} tasks`] : []),
              ...(list.archived ? ["archived"] : []),
            ].join(", ");
            responseLines.push(
              `  - ${list.name} (list_id: ${list.id}${extraInfo ? `, ${extraInfo}` : ""}) ${generateListUrl(list.id)}`,
            );
          });
        } else {
          responseLines.push("No lists found in this folder.");
        }

        // Add available statuses if present
        if (folderData.statuses && Array.isArray(folderData.statuses)) {
          const statuses = folderData.statuses.map((status: any) => ({
            name: status.status,
            type: status.type || "custom",
          }));
          responseLines.push(`Available statuses (${statuses.length} total):`);
          statuses.forEach((status: any) => {
            responseLines.push(`  - ${status.name} (${status.type})`);
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join("\n"),
            },
          ],
        };
      } catch (error) {
        console.error("Error getting folder info:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error getting folder info: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    },
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
      "Content is appended in markdown format with timestamp for tracking changes.",
    ].join("\n"),
    {
      list_id: z.string().min(1).describe("The list ID to update"),
      append_description: z
        .string()
        .min(1)
        .describe(
          "Markdown content to APPEND to existing list description (preserves existing content for safety)",
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async ({ list_id, append_description }) => {
      try {
        // Get current list info including description (try to get markdown content)
        const listResponse = await fetch(
          `https://api.clickup.com/api/v2/list/${list_id}?include_markdown_description=true`,
          {
            headers: { Authorization: CONFIG.apiKey },
          },
        );

        if (!listResponse.ok) {
          throw new Error(
            `Error fetching list: ${listResponse.status} ${listResponse.statusText}`,
          );
        }

        const listData = await listResponse.json();

        // Handle append-only description update with markdown support
        const currentDescription =
          listData.markdown_description ||
          listData.markdown_content ||
          listData.content ||
          "";
        const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD format
        const separator = currentDescription.trim() ? "\n\n---\n" : "";
        const finalDescription =
          currentDescription +
          separator +
          `**Edit (${timestamp}):** ${append_description}`;

        // Update the list description using markdown_content
        const updateResponse = await fetch(
          `https://api.clickup.com/api/v2/list/${list_id}`,
          {
            method: "PUT",
            headers: {
              Authorization: CONFIG.apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              markdown_content: finalDescription,
            }),
          },
        );

        if (!updateResponse.ok) {
          const errorData = await updateResponse.json().catch(() => ({}));
          throw new Error(
            `Error updating list: ${updateResponse.status} ${updateResponse.statusText} - ${JSON.stringify(errorData)}`,
          );
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
        console.error("Error updating list info:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating list info: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
