import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContentBlock } from "../shared/types";
import { generateSpaceUrl, generateListUrl, generateFolderUrl, generateDocumentUrl, getSpaceSearchIndex, getSpaceContent, performMultiTermSearch } from "../shared/utils";

export function registerSpaceTools(server: McpServer) {
  server.tool(
    "searchSpaces",
    [
      "Searches spaces (sometimes called projects) by name or ID with fuzzy matching.",
      "If 5 or fewer spaces match, automatically fetches all lists (sometimes called boards) and folders within those spaces to provide a complete tree structure.",
      "If more than 5 spaces match, returns only space information with guidance to search more precisely.",
      "You can search by space name (fuzzy matching) or provide an exact space ID.",
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
            const spaceLines: string[] = [];
            const totalLists = lists.length + folders.reduce((sum, f) => sum + (f.lists?.length || 0), 0);

            // Space header
            spaceLines.push(
              `🏢 SPACE: ${space.name} (space_id: ${space.id}${space.private ? ', private' : ''}${space.archived ? ', archived' : ''}) ${generateSpaceUrl(space.id)}`,
              `   ${totalLists} lists, ${folders.length} folders, ${documents.length} documents`
            );

            // Create a tree structure
            const hasDirectLists = lists.length > 0;
            const hasFolders = folders.length > 0;
            const hasDocuments = documents.length > 0;

            // Direct lists (not in folders)
            if (hasDirectLists) {
              lists.forEach((list: any, listIndex) => {
                const isLastDirectList = listIndex === lists.length - 1;
                const isLastOverall = !hasFolders && !hasDocuments && isLastDirectList;
                const treeChar = isLastOverall ? '└──' : '├──';
                const extraInfo = [
                  ...(list.task_count ? [`${list.task_count} tasks`] : []),
                  ...(list.private ? ['private'] : []),
                  ...(list.archived ? ['archived'] : [])
                ].join(', ');
                const listLine = `${treeChar} 📝 ${list.name} (list_id: ${list.id}${extraInfo ? `, ${extraInfo}` : ''}) ${generateListUrl(list.id)}`;
                spaceLines.push(listLine);
              });
            }

            // Folders and their lists
            if (hasFolders) {
              folders.forEach((folder: any, folderIndex) => {
                const isLastFolder = folderIndex === folders.length - 1;
                const isLastOverall = !hasDocuments && isLastFolder;
                const folderTreeChar = isLastOverall ? '└──' : '├──';
                const folderContinuation = isLastOverall ? '   ' : '│  ';
                
                const folderExtraInfo = [
                  ...(folder.lists?.length ? [`${folder.lists.length} lists`] : []),
                  ...(folder.private ? ['private'] : []),
                  ...(folder.archived ? ['archived'] : [])
                ].join(', ');
                
                const folderLine = `${folderTreeChar} 📂 ${folder.name} (folder_id: ${folder.id}${folderExtraInfo ? `, ${folderExtraInfo}` : ''}) ${generateFolderUrl(folder.id)}`;
                spaceLines.push(folderLine);

                // Lists within this folder
                if (folder.lists && folder.lists.length > 0) {
                  folder.lists.forEach((list: any, listIndex: number) => {
                    const isLastListInFolder = listIndex === folder.lists.length - 1;
                    const listTreeChar = isLastListInFolder ? '└──' : '├──';
                    const listExtraInfo = [
                      ...(list.task_count ? [`${list.task_count} tasks`] : []),
                      ...(list.private ? ['private'] : []),
                      ...(list.archived ? ['archived'] : [])
                    ].join(', ');
                    const listLine = `${folderContinuation}${listTreeChar} 📝 ${list.name} (list_id: ${list.id}${listExtraInfo ? `, ${listExtraInfo}` : ''}) ${generateListUrl(list.id)}`;
                    spaceLines.push(listLine);
                  });
                }
              });
            }

            // Documents attached to this space
            if (hasDocuments) {
              documents.forEach((document: any, docIndex) => {
                const isLastDocument = docIndex === documents.length - 1;
                const docTreeChar = isLastDocument ? '└──' : '├──';
                const docLine = `${docTreeChar} 📄 ${document.name} (doc_id: ${document.id}) ${generateDocumentUrl(document.id)}`;
                spaceLines.push(docLine);
              });
            }

            // Add the complete space as a single content block
            contentBlocks.push({
              type: "text" as const,
              text: spaceLines.join('\n')
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