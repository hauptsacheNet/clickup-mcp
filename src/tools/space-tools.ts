import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContentBlock } from "../shared/types";
import { getSpaceSearchIndex, getSpaceContent, performMultiTermSearch, formatSpaceTree, getFolderDetails, formatFolderTree } from "../shared/utils";

export function registerSpaceTools(server: McpServer) {
  server.tool(
    "searchSpaces",
    [
      "Searches spaces (sometimes called projects) by name or ID with fuzzy matching.",
      "If 5 or fewer spaces match, automatically fetches all lists (sometimes called boards) and folders within those spaces to provide a complete tree structure.",
      "If more than 5 spaces match, returns only space information with guidance to search more precisely.",
      "You can search by space name (fuzzy matching) or provide an exact space ID.",
      "You can also provide a folder_id to get details about a specific folder (its lists, statuses, and parent space).",
      "Always reference spaces by their URLs when discussing projects or suggesting actions."
    ].join("\n"),
    {
      terms: z
        .array(z.string())
        .optional()
        .describe("Array of search terms to match against space names or IDs. If not provided, returns all spaces. Ignored when folder_id is provided."),
      folder_id: z
        .string()
        .optional()
        .describe("A ClickUp folder ID to get details about a specific folder including its lists and parent space. When provided, terms and archived are ignored."),
      archived: z.boolean().optional().describe("Include archived spaces (default: false)")
    },
    {
      readOnlyHint: true
    },
    async ({ terms, folder_id, archived = false }) => {
      try {
        // If folder_id is provided, return folder details directly
        if (folder_id) {
          const folder = await getFolderDetails(folder_id);
          const folderText = formatFolderTree(folder);
          return {
            content: [
              { type: "text" as const, text: `Folder details for folder_id: ${folder_id}:` },
              { type: "text" as const, text: folderText },
            ],
          };
        }

        const searchIndex = await getSpaceSearchIndex();
        if (!searchIndex) {
          return {
            content: [{ type: "text", text: "Error: Could not build space search index." }],
          };
        }

        let matchingSpaces: any[] = [];

        if (!terms || terms.length === 0) {
          // Return all spaces if no search terms
          matchingSpaces = (searchIndex as any)._docs || [];
        } else {
          // Perform multi-term search with aggressive boosting
          matchingSpaces = await performMultiTermSearch(
            searchIndex,
            terms
            // No ID matcher or direct fetcher for spaces - they don't have direct API endpoints
          );
        }

        // Filter by archived status
        if (!archived) {
          matchingSpaces = matchingSpaces.filter((space: any) => !space.archived);
        }

        if (matchingSpaces.length === 0) {
          return {
            content: [{ type: "text", text: "No spaces found matching the search criteria." }],
          };
        }

        // Conditionally fetch detailed content based on result count
        const spaceContentPromises = matchingSpaces.map(async (space: any) => {
          try {
            if (matchingSpaces.length <= 5) {
              // Detailed mode: fetch lists and folders for this space
              const { lists, folders, documents } = await getSpaceContent(space.id);
              return { space, lists, folders, documents };
            } else {
              // Summary mode: just return space without content
              return { space, lists: [], folders: [], documents: [] };
            }
          } catch (error) {
            console.error(`Error fetching content for space ${space.id}:`, error);
            return { space, lists: [], folders: [], documents: [] };
          }
        });

        const spacesWithContent = await Promise.all(spaceContentPromises);
        const contentBlocks: ContentBlock[] = [];
        const isDetailedMode = matchingSpaces.length <= 5;

        if (isDetailedMode) {
          // Detailed mode: create separate blocks for each space
          spacesWithContent.forEach(({ space, lists, folders, documents }) => {
            // Use shared tree formatting function
            const spaceTreeText = formatSpaceTree(space, lists, folders, documents);
            
            // Add the complete space as a single content block
            contentBlocks.push({
              type: "text" as const,
              text: spaceTreeText
            });
          });
        } else {
          // Summary mode: create a single combined block with all spaces
          const allSpaceLines: string[] = [];
          spacesWithContent.forEach(({ space }) => {
            allSpaceLines.push(
              `🏢 SPACE: ${space.name} (space_id: ${space.id}${space.private ? ', private' : ''}${space.archived ? ', archived' : ''})`
            );
          });

          contentBlocks.push({
            type: "text" as const,
            text: allSpaceLines.join('\n')
          });
        }

        // Add tip message for summary mode (when there are too many spaces)
        if (matchingSpaces.length > 5) {
          contentBlocks.push({
            type: "text" as const,
            text: `\n💡 Tip: Use more specific search terms to get detailed list information (≤5 spaces will show complete structure)`
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: matchingSpaces.length <= 5 
                ? (() => {
                    const totalLists = spacesWithContent.reduce((sum, { lists, folders }) => 
                      sum + lists.length + folders.reduce((folderSum, f) => folderSum + (f.lists?.length || 0), 0), 0);
                    const totalDocuments = spacesWithContent.reduce((sum, { documents }) => sum + documents.length, 0);
                    return `Found ${matchingSpaces.length} space(s) with complete tree structure (${totalLists} total lists, ${totalDocuments} total documents):`;
                  })()
                : `Found ${matchingSpaces.length} space(s) - showing names and IDs only. Use more specific search terms to get detailed information:`
            },
            ...contentBlocks
          ],
        };


      } catch (error) {
        console.error('Error searching spaces:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error searching spaces: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}