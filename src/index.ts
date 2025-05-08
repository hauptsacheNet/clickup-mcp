import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { z } from "zod";
import { splitMarkdownAtImages } from "./markdown";

const CONFIG = {
  apiKey: process.env.CLICKUP_API_KEY!,
  teamId: process.env.CLICKUP_TEAM_ID!,
};

if (!CONFIG.apiKey || !CONFIG.teamId) {
  throw new Error("Missing Clickup API key or team ID");
}

// Create an MCP server
export const server = new McpServer({
  name: "Clickup MCP",
  version: "1.0.0",
});

server.tool(
  "getTaskById",
  "Get a Clickup task with images and comments by ID",
  {
    id: z
      .string()
      .min(7)
      .max(9)
      .describe(
        `The 7-9 character ID of the task to get without a prefix like "#" or "CU-"`
      ),
  },
  async ({ id }) => {
    const [task, comments] = await Promise.all([
      fetch(
        `https://api.clickup.com/api/v2/task/${id}?include_markdown_description=true`,
        { headers: { Authorization: CONFIG.apiKey } }
      ).then((res) => res.json()),
      fetch(`https://api.clickup.com/api/v2/task/${id}/comment`, {
        headers: { Authorization: CONFIG.apiKey },
      }).then((res) => res.json()),
    ]);

    // Process markdown description to split at image references
    const markdownBlocks = await splitMarkdownAtImages(
      task.markdown_description || "",
      task.attachments
    );

    return {
      content: [
        {
          type: "text",
          text: Object.entries({
            task_id: task.id,
            name: task.name,
            status: task.status.status,
            date_created: new Date(+task.date_created),
            date_updated: new Date(+task.date_updated),
            creator: task.creator.username,
            list: task.list.id,
          })
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n"),
        },
        // Include the processed markdown blocks with embedded images
        ...markdownBlocks,
        // Include comments ~ without images as those can't be read.
        ...comments.comments
          .sort((a: any, b: any) => +a.date - +b.date)
          .map((comment: any) => {
            return {
              type: "text",
              text: [
                Object.entries({
                  comment_id: comment.id,
                  date: new Date(+comment.date),
                  user: comment.user.username,
                })
                  .map(([key, value]) => `${key}: ${value}`)
                  .join("\n"),
                comment.comment_text,
              ].join("\n\n"),
            };
          }),
      ],
    };
  }
);

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
    const tasks = cachedTasks.filter((task) => {
      const taskNameLower = task.name.toLowerCase();
      return searchTerms.some((term) => taskNameLower.includes(term));
    });

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
      content: tasks.map((task: any) => ({
        type: "text",
        text: Object.entries({
          task_id: task.id,
          name: task.name,
          status: task.status.status,
          date_created: new Date(+task.date_created),
          date_updated: new Date(+task.date_updated),
          creator: task.creator.username,
          list: task.list.id,
        })
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n"),
      })),
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
      .filter((task) => task.status.type !== "done")
      .slice(0, 100);

    if (openTasks.length === 0) {
      return {
        content: [
          { type: "text", text: "No open tasks found for the current user." },
        ],
      };
    }

    return {
      content: openTasks.map((task: any) => ({
        type: "text",
        text: Object.entries({
          task_id: task.id,
          name: task.name,
          status: task.status.status,
          date_created: new Date(+task.date_created),
          date_updated: new Date(+task.date_updated),
          creator: task.creator.username,
          list: task.list.id,
        })
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n"),
      })),
    };
  }
);

// Only connect to the transport if this file is being run directly (not imported)
if (require.main === module) {
  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  server.connect(transport);
}
