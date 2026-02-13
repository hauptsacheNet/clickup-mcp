import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContentBlock } from "../shared/types";
import { getSpaceSearchIndex, getSpaceContent, getSpaceDetails, getFolder, performMultiTermSearch, formatSpaceTree, generateFolderUrl } from "../shared/utils";

export function registerSpaceTools(server: McpServer) {
  server.tool(
    "searchSpaces",
    [
      "Searches spaces (sometimes called projects) by name or ID with fuzzy matching.",
      "If 5 or fewer spaces match, automatically fetches all lists (sometimes called boards) and folders within those spaces to provide a complete tree structure.",
      "If more than 5 spaces match, returns only space information with guidance to search more precisely.",
      "You can search by space name (fuzzy matching) or provide an exact space or folder ID.",
      "When a folder ID is recognized, the parent space's full tree is returned with a hint indicating the matched folder.",
      "Always reference spaces by their URLs when discussing projects or suggesting actions."
    ].join("\n"),
    {
      terms: z
        .array(z.string())
        .optional()
        .describe("Array of search terms to match against space names or IDs. If not provided, returns all spaces."),
      archived: z.boolean().optional().describe("Include archived spaces (default: false)")
    },
    {
      readOnlyHint: true
    },
    async ({ terms, archived = false }) => {
      try {
        const searchIndex = await getSpaceSearchIndex();
        if (!searchIndex) {
          return {
            content: [{ type: "text", text: "Error: Could not build space search index." }],
          };
        }

        let matchingSpaces: any[] = [];
        const folderHints = new Map<string, string>(); // spaceId -> hint line

        if (!terms || terms.length === 0) {
          // Return all spaces if no search terms
          matchingSpaces = (searchIndex as any)._docs || [];
        } else {
          // Only try folder lookups for numeric terms (ClickUp folder IDs are numeric)
          const numericTerms = terms.filter(term => /^\d+$/.test(term));

          // Run Fuse search AND folder ID lookups in parallel
          const [fuseResults, ...folderResults] = await Promise.all([
            performMultiTermSearch(searchIndex, terms),
            ...numericTerms.map(term => getFolder(term).catch(() => null))
          ]);

          matchingSpaces = [...fuseResults];

          for (const folder of folderResults) {
            if (!folder?.space?.id) continue;
            const spaceId = folder.space.id;

            // Record the hint for this space
            folderHints.set(spaceId, `📂 Matched folder: ${folder.name} (folder_id: ${folder.id}) ${generateFolderUrl(folder.id)}`);

            // Add parent space to results if not already present from Fuse search
            if (!matchingSpaces.some((s: any) => s.id === spaceId)) {
              const spaceDetails = await getSpaceDetails(spaceId);
              matchingSpaces.push(spaceDetails);
            }
          }
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
            const hint = folderHints.get(space.id);

            // Add the complete space as a single content block, with folder hint if applicable
            contentBlocks.push({
              type: "text" as const,
              text: hint ? hint + '\n\n' + spaceTreeText : spaceTreeText
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