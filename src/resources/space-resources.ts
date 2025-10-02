import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSpaceSearchIndex, getSpaceContent, formatSpaceTree } from "../shared/utils";

/**
 * Extract space ID from clickup:// URI
 */
function extractSpaceIdFromUri(uriString: string): string {
  try {
    const url = new URL(uriString);
    const pathParts = url.pathname.split('/');
    return pathParts[pathParts.length - 1];
  } catch (error) {
    throw new Error(`Invalid ClickUp space URI: ${uriString}`);
  }
}


/**
 * Register ClickUp space resources using resource templates for dynamic discovery
 */
export function registerSpaceResources(server: McpServer) {
  // Create resource template for ClickUp spaces
  const spaceTemplate = new ResourceTemplate(
    "clickup://space/{spaceId}",
    {
      list: async () => {
        try {
          const searchIndex = await getSpaceSearchIndex();
          if (!searchIndex) {
            return { resources: [] };
          }

          const spaces = (searchIndex as any)._docs || [];
          // Filter out archived spaces for resource listing
          const activeSpaces = spaces.filter((space: any) => !space.archived);

          return {
            resources: activeSpaces.map((space: any) => ({
              uri: `clickup://space/${space.id}`,
              name: `${space.name} ClickUp Space.txt`,
              title: `${space.name} ClickUp Space`,
              mimeType: "text/plain"
            }))
          };
        } catch (error) {
          console.error("Error listing space resources:", error);
          return { resources: [] };
        }
      }
    }
  );

  // Register resource template for ClickUp spaces
  server.registerResource(
    "clickup-spaces",
    spaceTemplate,
    {
      title: "ClickUp Spaces",
      description: "Access ClickUp spaces with their complete structure including lists, folders, and documents",
    },
    async (uri: URL) => {
      try {
        const spaceId = extractSpaceIdFromUri(uri.toString());
        
        // Fetch space content including lists, folders, and documents
        const { lists, folders, documents } = await getSpaceContent(spaceId);
        
        // Get space details from the search index
        const searchIndex = await getSpaceSearchIndex();
        const spaces = (searchIndex as any)._docs || [];
        const space = spaces.find((s: any) => s.id === spaceId);
        
        if (!space) {
          return {
            contents: [{
              uri: uri.toString(),
              text: `Space with ID ${spaceId} not found.`,
            }]
          };
        }

        // Format the content using the shared tree formatting function
        const treeContent = formatSpaceTree(space, lists, folders, documents);
        
        // Add resource metadata
        const metadata = [
          '\n---',
          `ℹ️ Resource last updated: ${new Date().toISOString()}`,
          `💡 For real-time data, use the searchSpaces tool`
        ].join('\n');
        
        return {
          contents: [{
            uri: uri.toString(),
            text: treeContent + metadata,
          }]
        };
      } catch (error) {
        console.error("Error reading space resource:", error);
        return {
          contents: [{
            uri: uri.toString(),
            text: `Error reading space: ${error instanceof Error ? error.message : 'Unknown error'}`,
          }]
        };
      }
    }
  );
}