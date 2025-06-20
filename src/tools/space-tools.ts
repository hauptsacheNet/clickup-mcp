import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { ContentBlock } from "../shared/types";
import { generateSpaceUrl, generateListUrl, generateFolderUrl, getSpaceSearchIndex, getSpaceContent } from "../shared/utils";

export function registerSpaceTools(server: McpServer) {
  server.tool(
    "searchSpaces",
    [
      "Searches spaces (sometimes called projects or boards) by name or ID with fuzzy matching.",
      "If 5 or fewer spaces match, automatically fetches all lists and folders within those spaces to provide a complete tree structure.",
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
          // Search with fuzzy matching
          const uniqueResults = new Map<string, { item: any, score: number }>();
          
          terms.forEach(term => {
            const trimmedTerm = term.trim();
            if (trimmedTerm.length === 0) return;

            // Check if it's an exact space ID first
            const exactMatch = (searchIndex as any)._docs.find((space: any) => space.id === trimmedTerm);
            if (exactMatch) {
              uniqueResults.set(exactMatch.id, { item: exactMatch, score: 0 });
              return;
            }

            // Fuzzy search
            const results = searchIndex.search(trimmedTerm);
            results.forEach(result => {
              if (result.item && typeof result.item.id === 'string') {
                const currentScore = result.score ?? 1;
                const existing = uniqueResults.get(result.item.id);
                if (!existing || currentScore < existing.score) {
                  uniqueResults.set(result.item.id, {
                    item: result.item,
                    score: currentScore
                  });
                }
              }
            });
          });

          matchingSpaces = Array.from(uniqueResults.values())
            .sort((a, b) => a.score - b.score)
            .map(entry => entry.item);
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
              const { lists, folders } = await getSpaceContent(space.id);
              return { space, lists, folders };
            } else {
              // Summary mode: just return space without content
              return { space, lists: [], folders: [] };
            }
          } catch (error) {
            console.error(`Error fetching content for space ${space.id}:`, error);
            return { space, lists: [], folders: [] };
          }
        });

        const spacesWithContent = await Promise.all(spaceContentPromises);
        const contentBlocks: ContentBlock[] = [];

        spacesWithContent.forEach(({ space, lists, folders }, index) => {
          const spaceLines: string[] = [];
          const totalLists = lists.length + folders.reduce((sum, f) => sum + (f.lists?.length || 0), 0);

          // Space header
          spaceLines.push(
            `🏢 SPACE: ${space.name} (space_id: ${space.id}${space.private ? ', private' : ''}${space.archived ? ', archived' : ''}) ${generateSpaceUrl(space.id)}`,
            `   ${totalLists} lists, ${folders.length} folders`
          );

          // Create a tree structure
          const hasDirectLists = lists.length > 0;
          const hasFolders = folders.length > 0;

          // Direct lists (not in folders)
          if (hasDirectLists) {
            lists.forEach((list: any, listIndex) => {
              const isLastDirectList = listIndex === lists.length - 1;
              const isLastOverall = !hasFolders && isLastDirectList;
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
              const folderTreeChar = isLastFolder ? '└──' : '├──';
              const folderContinuation = isLastFolder ? '   ' : '│  ';
              
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

          // Add the complete space as a single content block
          contentBlocks.push({
            type: "text" as const,
            text: spaceLines.join('\n')
          });

          // Add separator between spaces (except for the last one)
          if (index < spacesWithContent.length - 1) {
            contentBlocks.push({
              type: "text" as const,
              text: '─'.repeat(50)
            });
          }
        });

        const totalLists = spacesWithContent.reduce((sum, { lists, folders }) => 
          sum + lists.length + folders.reduce((folderSum, f) => folderSum + (f.lists?.length || 0), 0), 0);

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
                ? `Found ${matchingSpaces.length} space(s) with complete tree structure (${totalLists} total lists):`
                : `Found ${matchingSpaces.length} space(s) - too many to show detailed list information. Please search more precisely to get complete tree structure with lists and folders:`
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