#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { z } from "zod";
import { processClickUpMarkdown, processClickUpText } from "./clickup-text";

const CONFIG = {
  apiKey: process.env.CLICKUP_API_KEY!,
  teamId: process.env.CLICKUP_TEAM_ID!,
  maxImages: process.env.MAX_IMAGES ? parseInt(process.env.MAX_IMAGES) : 4,
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
    const [content, comments] = await Promise.all([
      loadTaskContent(id),
      loadTaskComments(id),
    ]);
    
    // Combine all content and limit the number of images
    const allContent = [...content, ...comments];
    const limitedContent = limitImages(allContent, CONFIG.maxImages);
    
    return {
      content: limitedContent,
    };
  }
);

/**
 * Helper function to generate consistent task metadata
 */
function generateTaskMetadata(task: any) {
  const metadataLines = [
    `task_id: ${task.id}`,
    `name: ${task.name}`,
    `status: ${task.status.status}`,
    `date_created: ${new Date(+task.date_created)}`,
    `date_updated: ${new Date(+task.date_updated)}`,
    `creator: ${task.creator.username}`,
    `list: ${task.list.name} (${task.list.id})`,
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

async function loadTaskContent(id: string) {
  const response = await fetch(
    `https://api.clickup.com/api/v2/task/${id}?include_markdown_description=true&include_subtasks=true`,
    { headers: { Authorization: CONFIG.apiKey } }
  );
  const task = await response.json();
  const content = await processClickUpMarkdown(
    task.markdown_description || "",
    task.attachments
  );

  // Create the task metadata block using the helper function
  const taskMetadata = generateTaskMetadata(task);

  return [taskMetadata, ...content];
}

async function loadTaskComments(id: string) {
  const response = await fetch(
    `https://api.clickup.com/api/v2/task/${id}/comment`,
    { headers: { Authorization: CONFIG.apiKey } }
  );
  const comments = await response.json();
  return Promise.all(
    comments.comments
      // Sort comments by date, newest first to prioritize recent images
      .sort((a: any, b: any) => +b.date - +a.date)
      .map(async (comment: any) => {
        // Create a header for the comment
        const commentHeader: CallToolResult["content"][number] = {
          type: "text" as const,
          text: [
            `comment_id: ${comment.id}`,
            `date: ${new Date(+comment.date)}`,
            `user: ${comment.user.username}`,
          ].join("\n"),
        };

        // Process comment items if they exist
        if (comment.comment && Array.isArray(comment.comment)) {
          const commentContentBlocks = await processClickUpText(
            comment.comment
          );
          return [commentHeader, ...commentContentBlocks];
        } else {
          return [
            { type: "text", text: commentHeader.text },
            { type: "text", text: comment.comment_text },
          ];
        }
      })
  );
}

/**
 * Limits the number of images in the content array, replacing excess images with text placeholders
 * Prioritizes keeping the most recent images (assumes content is ordered with newest items last)
 * 
 * @param content Array of content blocks that may contain images
 * @param maxImages Maximum number of images to keep
 * @returns Modified content array with limited images
 */
function limitImages(content: CallToolResult["content"], maxImages: number): CallToolResult["content"] {
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

let cachedTasks: any[] = [];
let lastTaskCacheUpdate = 0;
server.tool(
  "searchTask",
  [
    "Searches tasks by name (case insensitive) with support for multiple search terms (OR logic).",
    "You'll get a rough overview of the tasks that match the search terms.",
    "Always use getTaskById to get more specific information if a task is relevant.",
  ].join("\n"),
  {
    terms: z
      .string()
      .min(3)
      .describe(
        "Search terms separated by '|' for OR logic (e.g., 'term1|term2|term3')"
      ),
  },
  async ({ terms }) => {
    const timeSinceLastUpdate = Date.now() - lastTaskCacheUpdate;
    if (timeSinceLastUpdate > 10000) {
      const taskLists = await Promise.all(
        [...Array(30)].map((_, i) => {
          return fetch(
            `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/task?order_by=updated&page=${i}`,
            { headers: { Authorization: CONFIG.apiKey } }
          ).then((res) => res.json());
        })
      );

      cachedTasks = taskLists.flatMap((taskList) => taskList.tasks);
      lastTaskCacheUpdate = Date.now();
    }

    const searchTerms = terms
      .split("|")
      .map((term) => term.trim().toLowerCase());
    
    // Check if any search term looks like a task ID
    const potentialTaskIds = searchTerms.filter(isTaskId);
    
    // Fetch tasks from cache that match search terms
    const tasksFromCache = cachedTasks.filter((task) => {
      const taskNameLower = task.name.toLowerCase();
      const taskId = task.id.toLowerCase();
      return searchTerms.some((term) => taskNameLower.includes(term) || taskId.includes(term));
    });
    
    // Fetch tasks by ID directly if they look like task IDs and they're not already in the cache
    const tasksToFetch = potentialTaskIds.filter(id => {
      // Check if this ID is already in the tasksFromCache
      return !tasksFromCache.some(task => task.id.toLowerCase() === id.toLowerCase());
    });
    
    const taskPromises = tasksToFetch.map(async (id) => {
      try {
        // Fetch task directly from API
        const response = await fetch(
          `https://api.clickup.com/api/v2/task/${id}`,
          { headers: { Authorization: CONFIG.apiKey } }
        );
        
        if (!response.ok) return null;
        
        const task = await response.json();
        return task;
      } catch (error) {
        console.error(`Error fetching task ${id}:`, error);
        return null;
      }
    });
    
    // Wait for all task fetches to complete
    const directlyFetchedTasks = await Promise.all(taskPromises);
    
    // Combine tasks from cache and directly fetched tasks, removing nulls
    const allTasks = [
      ...tasksFromCache,
      ...directlyFetchedTasks.filter(Boolean)
    ];
    
    const tasks = allTasks;

    if (tasks.length === 0) {
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
      content: tasks.map((task: any) => generateTaskMetadata(task)),
    };
  }
);

server.tool(
  "listTodo",
  "Lists all open tasks for the current user.",
  {},
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
      content: openTasks.map((task: any) => generateTaskMetadata(task)),
    };
  }
);

// Only connect to the transport if this file is being run directly (not imported)
if (require.main === module) {
  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  server.connect(transport);
}
