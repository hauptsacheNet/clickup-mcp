#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { z } from "zod";
import { processClickUpMarkdown, processClickUpText } from "./clickup-text";
import Fuse from 'fuse.js';

// Define ContentBlock type alias for clarity
type ContentBlock = CallToolResult['content'][number];

// --- Simplified Event Wrapper ---
interface DatedContentEvent {
  date: string; // Primary date for sorting this event
  contentBlocks: ContentBlock[]; // The actual content to be displayed for this event
}
// --- End Simplified Event Wrapper ---

const rawPrimaryLang = process.env.CLICKUP_PRIMARY_LANGUAGE || process.env.LANG;
let detectedLanguageHint: string | undefined = undefined;

if (rawPrimaryLang) {
  // Extract the primary language part (e.g., 'en' from 'en_US.UTF-8' or 'en-GB')
  // and convert to lowercase.
  const langPart = rawPrimaryLang.match(/^[a-zA-Z]{2,3}/);
  if (langPart) {
    detectedLanguageHint = langPart[0].toLowerCase();
  }
}

const CONFIG = {
  apiKey: process.env.CLICKUP_API_KEY!,
  teamId: process.env.CLICKUP_TEAM_ID!,
  maxImages: process.env.MAX_IMAGES ? parseInt(process.env.MAX_IMAGES) : 4,
  primaryLanguageHint: detectedLanguageHint, // Store the cleaned code directly
};

if (!CONFIG.apiKey || !CONFIG.teamId) {
  throw new Error("Missing Clickup API key or team ID");
}

// Create an MCP server
export const server = new McpServer({
  name: "Clickup MCP",
  version: "1.0.0",
});

/**
 * Checks if a string looks like a valid ClickUp task ID
 * Valid task IDs are 7-9 characters long and contain only alphanumeric characters
 */
function isTaskId(str: string): boolean {
  // Task IDs are 7-9 characters long and contain only alphanumeric characters
  return /^[a-z0-9]{7,9}$/i.test(str);
}

server.tool(
  "getTaskById",
  "Get a Clickup task with images and comments by ID",
  {
    id: z
      .string()
      .min(7)
      .max(9)
      .refine(val => isTaskId(val), {
        message: "Task ID must be 7-9 alphanumeric characters only"
      })
      .describe(
        `The 7-9 character ID of the task to get without a prefix like "#", "CU-" or "https://app.clickup.com/t/"`
      ),
  },
  async ({ id }) => {
    // 1. Load base task content, comment events, and status change events in parallel
    const [taskDetailContentBlocks, commentEvents, statusChangeEvents] = await Promise.all([
      loadTaskContent(id), // Returns Promise<ContentBlock[]>
      loadTaskComments(id), // Returns Promise<DatedContentEvent[]>
      loadTimeInStatusHistory(id), // Returns Promise<DatedContentEvent[]>
    ]);

    // 2. Combine comment and status change events
    const allDatedEvents: DatedContentEvent[] = [...commentEvents, ...statusChangeEvents];
    
    // 3. Sort all dated events chronologically
    allDatedEvents.sort((a, b) => {
      const dateA = a.date ? parseInt(a.date) : 0;
      const dateB = b.date ? parseInt(b.date) : 0;
      return dateA - dateB;
    });

    // 4. Flatten sorted events into a single ContentBlock stream
    let processedEventBlocks: ContentBlock[] = [];
    for (const event of allDatedEvents) {
      processedEventBlocks.push(...event.contentBlocks);
    }

    // 5. Combine task details with processed event blocks
    const allContentBlocks: ContentBlock[] = [...taskDetailContentBlocks, ...processedEventBlocks];
    
    // 6. Limit images
    const limitedContent: ContentBlock[] = limitImages(allContentBlocks, CONFIG.maxImages);
    
    return {
      content: limitedContent,
    };
  }
);

async function loadTaskContent(taskId: string): Promise<ContentBlock[]> {
  const response = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}?include_markdown_description=true&include_subtasks=true`,
    { headers: { Authorization: CONFIG.apiKey } }
  );
  const task = await response.json();
  const content: ContentBlock[] = await processClickUpMarkdown(
    task.markdown_description || "",
    task.attachments
  );

  // Create the task metadata block using the helper function
  const taskMetadata: ContentBlock = await generateTaskMetadata(task);

  return [taskMetadata, ...content];
}

async function loadTaskComments(id: string): Promise<DatedContentEvent[]> {
  const response = await fetch(
    `https://api.clickup.com/api/v2/task/${id}/comment?start_date=0`, // Ensure all comments are fetched
    { headers: { Authorization: CONFIG.apiKey } }
  );
  if (!response.ok) {
    console.error(`Error fetching comments for task ${id}: ${response.status} ${response.statusText}`);
    return [];
  }
  const commentsData = await response.json();
  if (!commentsData.comments || !Array.isArray(commentsData.comments)) {
    console.error(`Unexpected comment data structure for task ${id}`);
    return [];
  }
  const commentEvents: DatedContentEvent[] = await Promise.all(
    commentsData.comments.map(async (comment: any) => {
      const headerBlock: ContentBlock = {
        type: "text",
        text: `Comment by ${comment.user.username} on ${new Date(+comment.date)}:`,
      };
      
      const commentBodyBlocks: ContentBlock[] = await processClickUpText(comment.comment);
      
      return {
        date: comment.date, // String timestamp from ClickUp for sorting
        contentBlocks: [headerBlock, ...commentBodyBlocks],
      };
    })
  );
  return commentEvents;
}

async function loadTimeInStatusHistory(taskId: string): Promise<DatedContentEvent[]> {
  const url = `https://api.clickup.com/api/v2/task/${taskId}/time_in_status`;
  try {
    const response = await fetch(url, { headers: { Authorization: CONFIG.apiKey } });
    if (!response.ok) {
      console.error(`Error fetching time in status for task ${taskId}: ${response.status} ${response.statusText}`);
      return [];
    }
    // Using 'any' for less strict typing as per user preference, but keeping structure for clarity
    const data: any = await response.json(); 
    const events: DatedContentEvent[] = [];

    const processStatusEntry = (entry: any): DatedContentEvent | null => {
      if (!entry || !entry.total_time || !entry.total_time.since || !entry.status) return null;
      return {
        date: entry.total_time.since,
        contentBlocks: [{
          type: "text",
          text: `Status set to '${entry.status}' on ${new Date(+entry.total_time.since)}`,
        }],
      };
    };

    if (data.status_history && Array.isArray(data.status_history)) {
      data.status_history.forEach((historyEntry: any) => {
        const event = processStatusEntry(historyEntry);
        if (event) events.push(event);
      });
    }

    if (data.current_status) {
      const event = processStatusEntry(data.current_status);
      // Ensure current_status is only added if it's distinct or more recent than the last history item.
      // The deduplication logic below handles if it's the same as the last history entry.
      if (event) events.push(event);
    }
    
    // Deduplicate events based on date and status name to avoid adding current_status if it's identical to the last history entry
    const uniqueEvents = Array.from(new Map(events.map(event => 
      [`${event.date}-${event.contentBlocks[0]?.text}`, event] // Keying by date and text content of first block
    )).values());

    return uniqueEvents;
  } catch (error) {
    console.error(`Exception fetching time in status for task ${taskId}:`, error);
    return [];
  }
}

/**
 * Helper function to generate consistent task metadata
 */
async function generateTaskMetadata(task: any): Promise<ContentBlock> {
  let spaceName = task.space?.name || 'Unknown Space';
  let spaceIdForDisplay = task.space?.id || 'N/A';

  if (spaceName === 'Unknown Space' && task.space?.id) {
    const spaceDetails = await getSpaceDetails(task.space.id);
    if (spaceDetails && spaceDetails.name) {
      spaceName = spaceDetails.name;
    }
  }

  const metadataLines = [
    `task_id: ${task.id}`,
    `name: ${task.name}`,
    `status: ${task.status.status}`,
    `date_created: ${new Date(+task.date_created)}`,
    `date_updated: ${new Date(+task.date_updated)}`,
    `creator: ${task.creator.username}`,
    `assignee: ${task.assignees.map((a: any) => a.username).join(', ')}`,
    `list: ${task.list.name} (${task.list.id})`,
    `space: ${spaceName} (${spaceIdForDisplay})`,
  ];

  // Add parent task information if it exists
  if (typeof task.parent === "string") {
    metadataLines.push(`parent_task_id: ${task.parent}`);
  }

  // Add child task information if it exists
  if (task.subtasks && task.subtasks.length > 0) {
    metadataLines.push(`child_task_ids: ${task.subtasks.map((st: any) => st.id).join(', ')}`);
  }

  return {
    type: "text" as const,
    text: metadataLines.join("\n"),
  };
}

const spaceCache = new Map<string, Promise<any>>(); // Global cache for space details promises

/**
 * Function to get space details, using a cache to avoid redundant fetches
 */
async function getSpaceDetails(spaceId: string): Promise<any> {
  if (!spaceId) {
    return null;
  }
  if (!spaceCache.has(spaceId)) {
    const fetchPromise = fetch(`https://api.clickup.com/api/v2/space/${spaceId}`, {
      headers: { Authorization: CONFIG.apiKey },
    })
    .then(res => {
      if (!res.ok) {
        // Don't cache failed requests, or handle errors more gracefully
        console.error(`Error fetching space ${spaceId}: ${res.status}`);
        spaceCache.delete(spaceId); // Allow retry on next call
        return null;
      }
      return res.json();
    })
    .catch(error => {
      console.error(`Network error fetching space ${spaceId}:`, error);
      spaceCache.delete(spaceId); // Allow retry on next call
      return null;
    });
    spaceCache.set(spaceId, fetchPromise);
  }
  return spaceCache.get(spaceId);
}

/**
 * Limits the number of images in the content array, replacing excess images with text placeholders
 * Prioritizes keeping the most recent images (assumes content is ordered with newest items last)
 * 
 * @param content Array of content blocks that may contain images
 * @param maxImages Maximum number of images to keep
 * @returns Modified content array with limited images
 */
function limitImages(content: ContentBlock[], maxImages: number): ContentBlock[] {
  // Count how many images we have
  const imageIndices: number[] = [];
  
  // Find all image blocks
  content.forEach((block, index) => {
    if (block.type === "image") {
      imageIndices.push(index);
    }
  });
  
  // If we have fewer images than the limit, return the original content
  if (imageIndices.length <= maxImages) {
    return content;
  }
  
  // Determine which images to keep (the most recent ones)
  // We want to keep the last 'maxImages' images
  const imagesToRemove = imageIndices.slice(0, imageIndices.length - maxImages);
  
  // Create a new content array with excess images replaced by text
  return content.map((block, index) => {
    if (block.type === "image" && imagesToRemove.includes(index)) {
      return {
        type: "text" as const,
        text: "[Image removed due to size limitations. Only the most recent images are shown.]",
      };
    }
    return block;
  });
}

let taskSearchIndex: Fuse<any> | null = null;
let lastIndexUpdateTime = 0;
const INDEX_REFRESH_INTERVAL = 60000; // 60 seconds
const MAX_SEARCH_RESULTS = 50;

// Dynamically construct the searchTask description
const searchTaskDescriptionBase = [
  "Searches tasks by name, content, assignees, and ID (case insensitive) with fuzzy matching and support for multiple search terms (OR logic).",
  // Placeholder for language-specific guidance
  "You'll get a rough overview of the tasks that match the search terms, sorted by relevance.",
  "Always use getTaskById to get more specific information if a task is relevant.",
];

if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
  searchTaskDescriptionBase.splice(1, 0, `For optimal results, as your ClickUp tasks may be primarily in '${CONFIG.primaryLanguageHint}', consider providing search terms in English and '${CONFIG.primaryLanguageHint}'.`);
}

server.tool(
  "searchTask",
  searchTaskDescriptionBase.join("\n"),
  {
    terms: z
      .string()
      .min(3)
      .describe(
        "Search terms separated by '|' for OR logic (e.g., 'term1|term2|term3') or a direct task ID"
      ),
  },
  async ({ terms }) => {
    const now = Date.now();
    if (!taskSearchIndex || (now - lastIndexUpdateTime > INDEX_REFRESH_INTERVAL)) {
      console.error('Refreshing ClickUp task index...');
      const taskListsPromises = [...Array(30)].map((_, i) => {
        return fetch(
          `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/task?order_by=updated&page=${i}&subtasks=true`,
          { headers: { Authorization: CONFIG.apiKey } }
        ).then((res) => res.json()).catch(e => { 
          console.error(`Error fetching page ${i} for index:`, e);
          return { tasks: [] };
        });
      });
      const taskLists = await Promise.all(taskListsPromises);
      const allFetchedTasks = taskLists.flatMap(taskList => taskList.tasks);

      if (allFetchedTasks.length > 0) {
        taskSearchIndex = new Fuse(allFetchedTasks, {
          keys: [
            { name: 'name', weight: 0.7 },
            { name: 'id', weight: 0.6 },
            { name: 'text_content', weight: 0.5 }, // Task description/content
            { name: 'tags.name', weight: 0.4 },    // Task Tags
            { name: 'assignees.username', weight: 0.4 }, // Task Assignees
            { name: 'list.name', weight: 0.3 },     // Name of the List the task is in
            { name: 'folder.name', weight: 0.2 },   // Name of the Folder the task is in
            { name: 'space.name', weight: 0.1 }     // Name of the Space the task is in
          ],
          includeScore: true,
          threshold: 0.4,
          minMatchCharLength: 2,
        });
        lastIndexUpdateTime = now;
        console.error(`Task index refreshed with ${allFetchedTasks.length} tasks.`);
      } else {
        console.error('No tasks fetched to build search index.');
        // Potentially keep the old index if fetching failed, or clear it
        // For now, if fetching fails to get any tasks, the index won't update.
      }
    }

    const searchTermsArray = terms
      .split("|")
      .map((term) => term.trim())
      .filter(term => term.length > 0);

    if (searchTermsArray.length === 0) {
      return { content: [{ type: "text", text: "No search terms provided." }] };
    }

    const uniqueResults = new Map<string, { item: any, score: number }>();

    if (taskSearchIndex) {
      searchTermsArray.forEach(term => {
        const results = taskSearchIndex!.search(term.toLowerCase()); 
        results.forEach(result => {
          if (result.item && typeof result.item.id === 'string') {
            const currentScore = result.score ?? 1; // Default to 1 if undefined
            const existing = uniqueResults.get(result.item.id);
            if (!existing || currentScore < existing.score) {
              uniqueResults.set(result.item.id, { item: result.item, score: currentScore });
            }
          }
        });
      });
    }

    // Task ID Fallback Logic
    const potentialTaskIds = searchTermsArray.filter(isTaskId);
    const foundTaskIdsByFuse = new Set(Array.from(uniqueResults.keys()).map(id => id.toLowerCase())); // Store lowercase for comparison
    
    // Filter task IDs that were not found by Fuse, comparing case-insensitively
    const taskIdsToFetchDirectly = potentialTaskIds.filter(id => {
      const lowerId = id.toLowerCase();
      return !foundTaskIdsByFuse.has(lowerId);
    });

    if (taskIdsToFetchDirectly.length > 0) {
      console.error(`Attempting direct fetch for task IDs: ${taskIdsToFetchDirectly.join(', ')}`);
      const directFetchPromises = taskIdsToFetchDirectly.map(async (id) => {
        try {
          const response = await fetch(
            `https://api.clickup.com/api/v2/task/${id}`,
            { headers: { Authorization: CONFIG.apiKey } }
          );
          if (response.ok) {
            const task = await response.json();
            if (task && typeof task.id === 'string') {
              // Add/update with a perfect score if fetched directly, unless a better Fuse score already exists
              const existing = uniqueResults.get(task.id);
              if (!existing || 0 < existing.score) { // 0 is a perfect score
                 uniqueResults.set(task.id, { item: task, score: 0 }); 
              }
            }
            return task;
          }
          return null;
        } catch (error) {
          console.error(`Error directly fetching task ${id}:`, error);
          return null;
        }
      });
      await Promise.all(directFetchPromises);
    }

    const sortedResults = Array.from(uniqueResults.values())
      .sort((a, b) => a.score - b.score) // Sort by score, ascending (lower is better)
      .map(entry => entry.item)
      .slice(0, MAX_SEARCH_RESULTS); // Limit the number of results

    if (sortedResults.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No tasks found matching the search terms.",
          },
        ],
      };
    }

    return {
      content: await Promise.all(sortedResults.map((task: any) => generateTaskMetadata(task))),
    };
  }
);

server.tool(
  "listTodo",
  "Lists all open tasks for the current user.",
  async () => {
    // fetch current user ID
    const userResp = await fetch("https://api.clickup.com/api/v2/user", {
      headers: { Authorization: CONFIG.apiKey },
    }).then((res) => res.json());
    const userId = userResp.user.id;

    // page through team tasks assigned to this user
    const taskLists = await Promise.all(
      [...Array(10)].map((_, i) =>
        fetch(
          `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/task?order_by=updated&page=${i}&assignees[]=${userId}`,
          { headers: { Authorization: CONFIG.apiKey } }
        ).then((res) => res.json())
      )
    );
    const tasks = taskLists.flatMap((tl) => tl.tasks);

    // filter out closed tasks
    const openTasks = tasks
      .filter((task) => task.status.type !== "done") // done is not closed but also not a todo
      .slice(0, 50);

    if (openTasks.length === 0) {
      return {
        content: [
          { type: "text", text: "No open tasks found for the current user." },
        ],
      };
    }

    return {
      content: await Promise.all(openTasks.map((task: any) => generateTaskMetadata(task))),
    };
  }
);

// Only connect to the transport if this file is being run directly (not imported)
if (require.main === module) {
  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  server.connect(transport);
}
