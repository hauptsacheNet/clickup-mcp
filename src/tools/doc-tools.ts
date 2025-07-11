import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { generateDocumentUrl, getDocumentSearchIndex, performMultiTermSearch } from "../shared/utils";

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
- Use \`writeDocument\` with parent_type="doc" and parent_id="${doc_id}" to add the first page
- Example: writeDocument(parent_type="doc", parent_id="${doc_id}", page_name="Introduction", content="Your content here")`
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
          result.push(`Use \`writeDocument\` with page_id="${targetPage.id}" and your content.`);
          result.push(`Example: writeDocument(page_id="${targetPage.id}", content="Your content here")`);
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

  // Dynamically construct the searchDocuments description
  const searchDocumentsDescriptionBase = [
    "Search documents by name and space with fuzzy matching and support for multiple search terms (OR logic).",
    "This can be a great knowledge based for general project information. Consider searching for documents and for tasks at the same time.",
    "Can filter by specific space_ids. If no search terms provided, returns most recently updated documents."
  ];

  if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
    searchDocumentsDescriptionBase.push(`For optimal results, as your ClickUp documents may be primarily in '${CONFIG.primaryLanguageHint}', consider providing search terms in English and '${CONFIG.primaryLanguageHint}'.`);
  }

  searchDocumentsDescriptionBase.push("Always reference documents by their URLs when discussing search results or suggesting actions.");
  searchDocumentsDescriptionBase.push("You'll get document overview with space context - use readDocument to get full content.");

  server.tool(
    "searchDocuments",
    searchDocumentsDescriptionBase.join("\n"),
    {
      terms: z
        .array(z.string())
        .optional()
        .describe("Array of search terms to match against document names and spaces. If not provided, returns most recent documents."),
      space_ids: z
        .array(z.string())
        .optional()
        .describe("Filter documents to specific space IDs")
    },
    async ({ terms, space_ids }) => {
      try {
        // Get the document search index
        const searchIndex = await getDocumentSearchIndex(space_ids);
        if (!searchIndex) {
          return {
            content: [
              {
                type: "text",
                text: "Unable to create document search index.",
              },
            ],
          };
        }

        let results: any[];
        if (terms && terms.length > 0) {
          // Perform multi-term search
          results = await performMultiTermSearch(searchIndex, terms);
        } else {
          // Return all documents sorted by creation date (most recent first)
          const allResults = (searchIndex as any)._docs || [];
          results = allResults
            .sort((a: any, b: any) =>
              new Date(b.date_created || 0).getTime() - new Date(a.date_created || 0).getTime()
            );
        }

        // Limit results to prevent overwhelming the LLM
        const limitedResults = results.slice(0, 50);

        if (limitedResults.length === 0) {
          const searchTermsText = terms && terms.length > 0 ? ` for terms: ${terms.join(", ")}` : "";
          const spaceFilterText = space_ids && space_ids.length > 0 ? ` in spaces: ${space_ids.join(", ")}` : "";
          return {
            content: [
              {
                type: "text",
                text: [
                  `No documents found${searchTermsText}${spaceFilterText}.`,
                  `The content of documents is not searched, so ask the user for more details if needed.`,
                ].join("\n"),
              },
            ],
          };
        }

        // Format results
        const responseLines = [
          `Found ${limitedResults.length} document${limitedResults.length === 1 ? "" : "s"}:`
        ];

        limitedResults.forEach((doc: any, index: number) => {
          const docUrl = generateDocumentUrl(doc.id);
          const createdDate = doc.date_created ? new Date(+doc.date_created).toLocaleDateString() : 'Unknown';
          const meta: string[] = [`doc_id ${doc.id}`];

          // Show parent information
          if (doc.parent_info) {
            meta.push(doc.parent_info);
          }

          meta.push(`Created: ${createdDate}`);
          responseLines.push(
            `- ${doc.name} (${meta.join(', ')}) ${docUrl}`
          );
        });

        responseLines.push(
          "",
          "Use `readDocument` with a document ID to view full content and page structure."
        );

        return {
          content: [
            {
              type: "text",
              text: responseLines.join("\n"),
            },
          ],
        };

      } catch (error) {
        console.error('Error searching documents:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error searching documents: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

export function registerDocumentToolsWrite(server: McpServer) {
  server.tool(
    "writeDocument",
    [
      "Universal tool for document and page operations with smart document creation.",
      "Create new documents by using parent_type 'space' or 'list'.",
      "Create pages in existing documents by using parent_type 'doc'.",
      "Create sub-pages by using parent_type 'page'.",
      "Update existing pages by providing page_id.",
      "Always reference documents by their URLs when creating or updating."
    ].join("\n"),
    {
      page_id: z
        .string()
        .optional()
        .describe("Optional page ID to update (if provided, updates existing page; if not, creates new page/document)"),
      parent_type: z
        .enum(["space", "list", "doc", "page"])
        .optional()
        .describe("Type of parent when creating new content (required if page_id not provided)"),
      parent_id: z
        .string()
        .optional()
        .describe("ID of parent (space, list, document, or page) when creating new content (required if page_id not provided)"),
      page_name: z
        .string()
        .optional()
        .describe("Name for the page (required for new pages, optional for updates to rename)"),
      content: z
        .string()
        .optional()
        .describe("Page content in markdown format (optional for updates)"),
      append: z
        .boolean()
        .optional()
        .describe("Whether to append content to existing page content (default: false - replaces content)")
    },
    async ({ page_id, parent_type, parent_id, page_name, content, append = false }) => {
      try {
        // Validate input parameters
        if (!page_id && (!parent_type || !parent_id)) {
          return {
            content: [{ 
              type: "text", 
              text: "Error: Either page_id (for updates) or both parent_type and parent_id (for creation) must be provided."
            }],
          };
        }

        if (!page_id && !page_name) {
          return {
            content: [{ 
              type: "text", 
              text: "Error: page_name is required when creating new pages."
            }],
          };
        }

        // Case 1: Update existing page
        if (page_id) {
          const requestBody: any = {};
          
          if (page_name) {
            requestBody.name = page_name;
          }
          
          if (content !== undefined) {
            requestBody.content = content;
            // Use native append mode from ClickUp API
            requestBody.content_edit_mode = append ? 'append' : 'replace';
          }

          const response = await fetch(`https://api.clickup.com/api/v3/docs/pages/${page_id}`, {
            method: 'PUT',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            throw new Error(`Error updating page: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          const updatedPage = data.page;

          return {
            content: [{ 
              type: "text", 
              text: `✅ Successfully updated page "${updatedPage.name}" (${page_id})\n\nPage URL: ${generateDocumentUrl(updatedPage.doc_id, page_id)}`
            }],
          };
        }

        // Case 2: Create new content
        let docId: string;
        
        if (parent_type === "space" || parent_type === "list") {
          // Create new document first, then create first page manually
          const docRequestBody: any = {
            name: page_name, // Document name matches first page name
            create_page: false, // Don't auto-create page, we'll create it manually for better control
            parent: {
              id: parent_id,
              type: parent_type === "space" ? 4 : parent_type === "list" ? 6 : 7 // 4=Space, 6=List, 7=Workspace
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
            throw new Error(`Error creating document: ${docResponse.status} ${docResponse.statusText}`);
          }

          const docData = await docResponse.json();
          docId = docData.id;

          // Create the first page manually for better control
          const pageRequestBody = {
            name: page_name,
            content: content || '',
          };

          const pageResponse = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${docId}/pages`, {
            method: 'POST',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(pageRequestBody),
          });

          if (!pageResponse.ok) {
            throw new Error(`Error creating first page: ${pageResponse.status} ${pageResponse.statusText}`);
          }

          const pageData = await pageResponse.json();
          const firstPage = pageData.page || pageData;

          return {
            content: [{ 
              type: "text", 
              text: `✅ Successfully created new document "${page_name}" with first page\n\nDocument URL: ${generateDocumentUrl(docId)}\nFirst Page URL: ${generateDocumentUrl(docId, firstPage.id)}`
            }],
          };

        } else if (parent_type === "doc") {
          // Create new page in existing document
          docId = parent_id!;
          
          const pageRequestBody = {
            name: page_name,
            content: content || '',
          };

          const response = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs/${docId}/pages`, {
            method: 'POST',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(pageRequestBody),
          });

          if (!response.ok) {
            throw new Error(`Error creating page: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          const newPage = data.page;

          return {
            content: [{ 
              type: "text", 
              text: `✅ Successfully created page "${newPage.name}" (${newPage.id}) in document\n\nPage URL: ${generateDocumentUrl(docId, newPage.id)}`
            }],
          };

        } else if (parent_type === "page") {
          // Create sub-page under existing page
          const pageRequestBody = {
            name: page_name,
            content: content || '',
            parent_page_id: parent_id
          };

          // For sub-pages, we need to get the doc_id from the parent page first
          // This is a limitation we'll need to handle - for now, use a generic endpoint
          const response = await fetch(`https://api.clickup.com/api/v3/docs/pages`, {
            method: 'POST',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(pageRequestBody),
          });

          if (!response.ok) {
            throw new Error(`Error creating sub-page: ${response.status} ${response.statusText}`);
          }

          const data = await response.json();
          const newPage = data.page;

          return {
            content: [{ 
              type: "text", 
              text: `✅ Successfully created sub-page "${newPage.name}" (${newPage.id}) under parent page ${parent_id}\n\nPage URL: ${generateDocumentUrl(newPage.doc_id, newPage.id)}`
            }],
          };
        }

        return {
          content: [{ type: "text", text: "Error: Invalid parent_type specified." }],
        };

      } catch (error) {
        console.error('Error in writeDocument:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error in document/page operation: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}