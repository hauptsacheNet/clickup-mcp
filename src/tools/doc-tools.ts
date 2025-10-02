import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { generateDocumentUrl } from "../shared/utils";

/**
 * Helper function to recursively extract all pages from nested page structure
 */
function extractAllPages(pageGroup: any): any[] {
  const allPages = [];
  
  // Add the page itself
  allPages.push({
    id: pageGroup.id,
    name: pageGroup.name,
    doc_id: pageGroup.doc_id,
    parent_page_id: pageGroup.parent_page_id || null
  });
  
  // Recursively add nested pages
  if (pageGroup.pages && Array.isArray(pageGroup.pages)) {
    pageGroup.pages.forEach((nestedPage: any) => {
      allPages.push(...extractAllPages(nestedPage));
    });
  }
  
  return allPages;
}

/**
 * Helper function to display page hierarchy with proper indentation
 */
function displayPageHierarchy(pageGroup: any, currentPageId: string, depth: number = 0): string[] {
  const result = [];
  const indent = '  '.repeat(depth); // 2 spaces per level
  const isCurrentPage = pageGroup.id === currentPageId;
  const prefix = isCurrentPage ? '▶️ ' : '   ';
  const pageIndicator = isCurrentPage ? ' ← **Currently viewing**' : '';
  
  // Display this page
  result.push(`${indent}${prefix}${pageGroup.name} (${pageGroup.id})${pageIndicator}`);
  
  // Recursively display nested pages
  if (pageGroup.pages && Array.isArray(pageGroup.pages)) {
    pageGroup.pages.forEach((nestedPage: any) => {
      result.push(...displayPageHierarchy(nestedPage, currentPageId, depth + 1));
    });
  }
  
  return result;
}

export function registerDocumentToolsRead(server: McpServer) {
  server.tool(
    "readDocument",
    [
      "Get a ClickUp document with page structure and content.",
      "Documents can be discovered via searchSpaces (which includes documents in space tree) or by direct URL from the user or within tasks.",
      "Always use the document URL when referencing documents in conversations or sharing with others.",
      "The response provides complete document metadata, page structure, and requested page content.",
      `Document URLs look like this: ${generateDocumentUrl('doc_id', 'page_id')}`,
    ].join("\n"),
    {
      doc_id: z
        .string()
        .min(1)
        .describe("The document ID to read"),
      page: z
        .string()
        .optional()
        .describe("Optional specific page ID or name to read (defaults to first page)")
    },
    {
      readOnlyHint: true
    },
    async ({ doc_id, page }) => {
      try {
        // First get the document details and page structure
        const [docResponse, pagesResponse] = await Promise.all([
          fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${doc_id}`, {
            headers: { Authorization: CONFIG.apiKey },
          }),
          fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${doc_id}/pageListing`, {
            headers: { Authorization: CONFIG.apiKey },
          })
        ]);

        if (!docResponse.ok) {
          throw new Error(`Error fetching document: ${docResponse.status} ${docResponse.statusText}`);
        }

        if (!pagesResponse.ok) {
          throw new Error(`Error fetching pages: ${pagesResponse.status} ${pagesResponse.statusText}`);
        }

        const docData = await docResponse.json();
        const pagesData = await pagesResponse.json();
        
        const doc = docData; // Document data is flat
        // Extract all pages while preserving hierarchy for display
        const pages: any[] = [];
        const hierarchicalPages = pagesData; // Keep original structure for hierarchy display
        
        // Extract flat list of pages for searching and navigation
        pagesData.forEach((pageGroup: any) => {
          pages.push(...extractAllPages(pageGroup));
        });

        if (pages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `📄 **Document: ${doc.name}** (doc_id: ${doc_id})
📎 Document URL: ${generateDocumentUrl(doc_id)}

⚠️ This document exists but has no pages yet.

**Next steps:**
- Use \`createDocumentOrPage\` with doc_id="${doc_id}" to add the first page
- Example: createDocumentOrPage(doc_id="${doc_id}", name="Introduction", content="Your content here")`
            }],
          };
        }

        // Determine which page to read
        let targetPage = null;
        if (page) {
          // Look for page by ID first, then by name
          targetPage = pages.find((p: any) => p.id === page || p.name === page);
          if (!targetPage) {
            return {
              content: [{ 
                type: "text", 
                text: `Page "${page}" not found in document "${doc.name}". Available pages: ${pages.map((p: any) => `"${p.name}" (${p.id})`).join(', ')}`
              }],
            };
          }
        } else {
          // Default to first page
          targetPage = pages[0];
        }

        // Get the specific page content
        const pageResponse = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${doc_id}/pages/${targetPage.id}`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!pageResponse.ok) {
          throw new Error(`Error fetching page content: ${pageResponse.status} ${pageResponse.statusText}`);
        }

        const pageData = await pageResponse.json();
        const pageContent = pageData; // Page data is flat

        // Build the response
        const result = [];
        
        // Document header with metadata
        result.push(`doc_id: ${doc.id}`)
        result.push(`Document Title: ${doc.name}`);
        result.push(`Document URL: ${generateDocumentUrl(doc_id)}`);
        result.push(`Current page_id: ${targetPage.id}`);
        result.push(`Current Page Title: ${pageContent.name}`);
        result.push(`Current Page URL: ${generateDocumentUrl(doc_id, targetPage.id)}`);

        // Page structure overview with hierarchy
        result.push('Page Structure:');
        hierarchicalPages.forEach((pageGroup: any) => {
          result.push(...displayPageHierarchy(pageGroup, targetPage.id));
        });

        // Current page content
        if (pageContent.content && pageContent.content.trim()) {
          result.push(`Page Content:`);
          return {
            content: [
              {type: "text", text: result.join('\n')},
              {type: "text", text: pageContent.content},
            ],
          };
        } else {
          result.push('*This page is empty.*');
          result.push('');
          result.push('**💡 To add content to this page:**');
          result.push(`Use \`updateDocumentPage\` with doc_id="${doc_id}", page_id="${targetPage.id}" and your content.`);
          result.push(`Example: updateDocumentPage(doc_id="${doc_id}", page_id="${targetPage.id}", content="Your content here")`);
          return {
            content: [
              {type: "text", text: result.join('\n')},
            ],
          };
        }

      } catch (error) {
        console.error('Error reading document:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error reading document ${doc_id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

export function registerDocumentToolsWrite(server: McpServer) {
  server.tool(
    "updateDocumentPage",
    [
      "Updates an existing document page's content and/or name.",
      "Use this when you have both doc_id and page_id from readDocument.",
      "Content is in markdown format and can be replaced or appended.",
      "Always reference documents by their URLs when sharing with users."
    ].join("\n"),
    {
      doc_id: z
        .string()
        .min(1)
        .describe("The document ID containing the page (from readDocument)"),
      page_id: z
        .string()
        .min(1)
        .describe("The page ID to update (from readDocument)"),
      name: z
        .string()
        .optional()
        .describe("Optional: new name for the page"),
      content: z
        .string()
        .optional()
        .describe("Optional: page content in markdown format"),
      append: z
        .boolean()
        .optional()
        .describe("Whether to append content to existing page content (default: false - replaces content)")
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    async ({ doc_id, page_id, name, content, append = false }) => {
      try {
        const requestBody: any = {};

        if (name) {
          requestBody.name = name;
        }

        if (content !== undefined) {
          requestBody.content = content;
          requestBody.content_edit_mode = append ? 'append' : 'replace';
        }

        if (Object.keys(requestBody).length === 0) {
          return {
            content: [{
              type: "text",
              text: "Error: At least one of 'name' or 'content' must be provided for update."
            }],
          };
        }

        const response = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${doc_id}/pages/${page_id}`, {
          method: 'PUT',
          headers: {
            Authorization: CONFIG.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Error updating page: ${response.status} ${response.statusText}. ${errorText}`);
        }

        // Handle potentially empty response
        const responseText = await response.text();
        let updatedPage: any = {};

        if (responseText && responseText.trim()) {
          try {
            const data = JSON.parse(responseText);
            updatedPage = data.page || data;
          } catch (e) {
            // If JSON parsing fails, continue with empty updatedPage object
            console.error('Warning: Could not parse response JSON, but update was successful');
          }
        }

        const pageName = updatedPage.name || name || "page";

        return {
          content: [{
            type: "text",
            text: `✅ Successfully updated page "${pageName}" (page_id: ${page_id})\n\nPage URL: ${generateDocumentUrl(doc_id, page_id)}`
          }],
        };

      } catch (error) {
        console.error('Error updating document page:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating page: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "createDocumentOrPage",
    [
      "Creates a new document with its first page, OR adds a page to an existing document.",
      "To create a NEW document: provide space_id OR list_id + name + content",
      "To add a page to EXISTING document: provide doc_id + name + content",
      "To create a sub-page: provide doc_id + parent_page_id + name + content",
      "Content is in markdown format and supports ClickUp's markdown features.",
      "Always reference documents by their URLs when sharing with users."
    ].join("\n"),
    {
      space_id: z
        .string()
        .optional()
        .describe("Create NEW document in this space (mutually exclusive with list_id and doc_id)"),
      list_id: z
        .string()
        .optional()
        .describe("Create NEW document in this list (mutually exclusive with space_id and doc_id)"),
      doc_id: z
        .string()
        .optional()
        .describe("Add page to EXISTING document with this ID (mutually exclusive with space_id and list_id)"),
      parent_page_id: z
        .string()
        .optional()
        .describe("Optional: when provided with doc_id, creates a sub-page under this parent page"),
      name: z
        .string()
        .min(1)
        .describe("Name for the document/page being created"),
      content: z
        .string()
        .optional()
        .describe("Optional: page content in markdown format")
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ space_id, list_id, doc_id, parent_page_id, name, content }) => {
      try {
        // Validate mutually exclusive parameters
        const locationParams = [space_id, list_id, doc_id].filter(Boolean).length;
        if (locationParams !== 1) {
          return {
            content: [{
              type: "text",
              text: "Error: Provide exactly ONE of: space_id (new doc in space), list_id (new doc in list), or doc_id (page in existing doc)."
            }],
          };
        }

        if (parent_page_id && !doc_id) {
          return {
            content: [{
              type: "text",
              text: "Error: parent_page_id requires doc_id to be provided."
            }],
          };
        }

        // Case 1: Create new document in space or list
        if (space_id || list_id) {
          const parentId = space_id || list_id;
          const parentType = space_id ? 4 : 6; // 4=Space, 6=List

          // Create new document
          const docRequestBody = {
            name: name,
            create_page: false,
            parent: {
              id: parentId,
              type: parentType
            }
          };

          const docResponse = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs`, {
            method: 'POST',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(docRequestBody),
          });

          if (!docResponse.ok) {
            const errorText = await docResponse.text();
            throw new Error(`Error creating document: ${docResponse.status} ${docResponse.statusText}. ${errorText}`);
          }

          const docData = await docResponse.json();
          const newDocId = docData.id;

          // Create the first page
          const pageRequestBody = {
            name: name,
            content: content || '',
          };

          const pageResponse = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${newDocId}/pages`, {
            method: 'POST',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(pageRequestBody),
          });

          if (!pageResponse.ok) {
            const errorText = await pageResponse.text();
            throw new Error(`Error creating first page: ${pageResponse.status} ${pageResponse.statusText}. ${errorText}`);
          }

          const pageData = await pageResponse.json();
          const firstPage = pageData.page || pageData;

          return {
            content: [{
              type: "text",
              text: `✅ Successfully created new document "${name}" (doc_id: ${newDocId})\n\nDocument URL: ${generateDocumentUrl(newDocId)}\nFirst Page URL: ${generateDocumentUrl(newDocId, firstPage.id)}`
            }],
          };
        }

        // Case 2: Add page to existing document or create sub-page
        if (doc_id) {
          const pageRequestBody: any = {
            name: name,
            content: content || '',
          };

          if (parent_page_id) {
            pageRequestBody.parent_page_id = parent_page_id;
          }

          const response = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${doc_id}/pages`, {
            method: 'POST',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(pageRequestBody),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Error creating page: ${response.status} ${response.statusText}. ${errorText}`);
          }

          const data = await response.json();
          const newPage = data.page || data;

          const pageType = parent_page_id ? "sub-page" : "page";
          const parentInfo = parent_page_id ? ` under parent page ${parent_page_id}` : "";

          return {
            content: [{
              type: "text",
              text: `✅ Successfully created ${pageType} "${newPage.name}" (page_id: ${newPage.id})${parentInfo}\n\nPage URL: ${generateDocumentUrl(doc_id, newPage.id)}`
            }],
          };
        }

        return {
          content: [{ type: "text", text: "Error: Unexpected state in document/page creation." }],
        };

      } catch (error) {
        console.error('Error creating document or page:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error creating document or page: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}