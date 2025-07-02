import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { getCurrentUser } from "../shared/utils";

// Shared schemas for task parameters
const taskNameSchema = z.string().min(1).describe("The name/title of the task");
const taskPrioritySchema = z.enum(["urgent", "high", "normal", "low"]).optional().describe("Optional priority level");
const taskDueDateSchema = z.string().optional().describe("Optional due date as ISO date string (e.g., '2024-10-06T23:59:59+02:00')");
const taskStartDateSchema = z.string().optional().describe("Optional start date as ISO date string (e.g., '2024-10-06T09:00:00+02:00')");
const taskTimeEstimateSchema = z.number().optional().describe("Optional time estimate in hours (will be converted to milliseconds)");
const taskTagsSchema = z.array(z.string()).optional().describe("Optional array of tag names");

export function registerTaskToolsWrite(server: McpServer, userData: any) {
  server.tool(
    "addComment",
    (() => {
      const descriptionBase = [
        "Adds a comment to a specific task.",
        "LINKING BEST PRACTICES:",
        "- Always reference related tasks using ClickUp URLs (https://app.clickup.com/t/TASK_ID)",
        "- Include task links when mentioning dependencies, related work, or follow-ups",
        "- Link to relevant lists, spaces, or other ClickUp entities when applicable",
        "PROGRESS UPDATES: Include current status, progress information, and next steps.",
        "If external links are provided, verify they are publicly accessible and incorporate relevant information.",
        "Check the task's current status - if it's in 'backlog' or similar inactive states, suggest moving it to an active status like 'in progress' when work is being done."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing comments in '${CONFIG.primaryLanguageHint}' unless the task is already in another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to comment on"),
      comment: z.string().min(1).describe("The comment text to add to the task"),
    },
    async ({ task_id, comment }) => {
      try {
        const requestBody = {
          comment_text: comment,
          notify_all: true
        };

        const response = await fetch(`https://api.clickup.com/api/v2/task/${task_id}/comment`, {
          method: 'POST',
          headers: {
            Authorization: CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Error adding comment: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const commentData = await response.json();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Comment added successfully!`,
                `comment_id: ${commentData.id || 'N/A'}`,
                `task_id: ${task_id}`,
                `comment: ${comment}`,
                `date: ${timestampToIso(commentData.date || Date.now())}`,
                `user: ${commentData.user?.username || 'Current user'}`,
              ].join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error adding comment:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error adding comment: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "updateTask",
    (() => {
      const descriptionBase = [
        "Updates various aspects of an existing task.",
        "ALWAYS include the task URL (https://app.clickup.com/t/TASK_ID) when updating or referencing tasks.",
        "Use getListInfo first to see valid status options.",
        "SAFETY FEATURE: Description updates are APPEND-ONLY to prevent data loss - existing content is preserved.",
        "STATUS UPDATES: Use the `addComment` tool for progress reports, work logs, and status updates rather than the task description.",
        "Task descriptions should contain requirements, specifications, and core task information.",
        "LINKING IN DESCRIPTIONS: When appending descriptions, include links to related tasks, lists, or external resources.",
        "IMPORTANT: When updating tasks (especially when booking time or adding progress), ensure the status makes sense for the work being done - tasks in 'backlog' or 'closed' states usually shouldn't have active work.",
        "Suggest appropriate status transitions and always provide the clickable task URL in responses."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing task names and descriptions in '${CONFIG.primaryLanguageHint}' unless the task is already in another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to update"),
      name: taskNameSchema.optional(),
      append_description: z.string().optional().describe("Optional markdown content to APPEND to existing task description (preserves existing content for safety)"),
      status: z.string().optional().describe("Optional new status name - use getListInfo to see valid options"),
      priority: taskPrioritySchema,
      due_date: taskDueDateSchema,
      start_date: taskStartDateSchema,
      time_estimate: taskTimeEstimateSchema,
      tags: taskTagsSchema.describe("Optional array of tag names (will replace existing tags)"),
      parent_task_id: z.string().optional().describe("Optional parent task ID to change parent/child relationships"),
      assignees: z.array(z.string()).optional().describe(createAssigneeDescription(userData))
    },
    async ({ task_id, name, append_description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees }) => {
      try {
        const userData = await getCurrentUser();

        // Get task details including current markdown description
        const taskResponse = await fetch(`https://api.clickup.com/api/v2/task/${task_id}?include_markdown_description=true`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!taskResponse.ok) {
          throw new Error(`Error fetching task: ${taskResponse.status} ${taskResponse.statusText}`);
        }

        const taskData = await taskResponse.json();

        // Handle append-only description update with markdown support
        let finalDescription: string | undefined;
        if (append_description) {
          const currentDescription = taskData.markdown_description || "";
          const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
          const separator = currentDescription.trim() ? "\n\n---\n" : "";
          finalDescription = currentDescription + separator + `**Edit (${timestamp}):** ${append_description}`;
        }

        // Build update body using shared utility (without description since we handle it separately)
        const updateBody = buildTaskRequestBody({
          name, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees
        });

        // Add markdown description if we have content to append
        if (finalDescription !== undefined) {
          updateBody.markdown_description = finalDescription;
        }

        // Handle assignees for updates (different from creates)
        if (assignees !== undefined) {
          updateBody.assignees = { add: assignees, rem: [] }; // Add new assignees, remove none
        }

        // Check if there's anything to update
        if (Object.keys(updateBody).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No updates provided. Please specify at least one field to update.",
              },
            ],
          };
        }

        // Update the task
        const updateResponse = await fetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
          method: 'PUT',
          headers: {
            Authorization: CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateBody)
        });

        if (!updateResponse.ok) {
          const errorData = await updateResponse.json().catch(() => ({}));
          throw new Error(`Error updating task: ${updateResponse.status} ${updateResponse.statusText} - ${JSON.stringify(errorData)}`);
        }

        const updatedTask = await updateResponse.json();

        const responseLines = formatTaskResponse(updatedTask, 'updated', {
          name, append_description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees
        }, userData);

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error updating task:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating task: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "createTask",
    (() => {
      const descriptionBase = [
        "Creates a new task in a specific list and assigns it to specified users (defaults to current user).",
        "CRITICAL LINKING REQUIREMENTS:",
        "- ALWAYS search for similar existing tasks first using searchTasks to avoid duplicates",
        "- Include links to related tasks in the description (format: https://app.clickup.com/t/TASK_ID)",
        "- Reference parent/child tasks, dependencies, and related work with clickable links",
        "- The response will include the new task's clickable URL - always share this link",
        "Use getListInfo first to understand the list context and available statuses.",
        "Task descriptions support full markdown formatting including **bold**, *italic*, lists, links, and code blocks.",
        "BEST PRACTICE: Every task creation should result in sharing the clickable task URL for future reference."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing task names and descriptions in '${CONFIG.primaryLanguageHint}' unless specified otherwise or unless the context requires another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      list_id: z.string().min(1).describe("The ID of the list where the task will be created. Note: ClickUp API does not support moving tasks between lists after creation - this must be done manually in the ClickUp interface"),
      name: taskNameSchema,
      description: z.string().optional().describe("Optional markdown description for the task - supports full markdown formatting"),
      status: z.string().optional().describe("Optional status name - use getListInfo to see valid options"),
      priority: taskPrioritySchema,
      due_date: taskDueDateSchema,
      start_date: taskStartDateSchema,
      time_estimate: taskTimeEstimateSchema,
      tags: taskTagsSchema,
      parent_task_id: z.string().optional().describe("Optional parent task ID to create this as a subtask"),
      assignees: z.array(z.string()).optional().describe(createAssigneeDescription(userData))
    },
    async ({ list_id, name, description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees }) => {
      try {
        const userData = await getCurrentUser();
        const currentUserId = userData.user.id;

        const requestBody = buildTaskRequestBody({
          name, status, priority, due_date, start_date, time_estimate, tags, assignees, parent_task_id
        }, currentUserId);

        // Add markdown description if provided
        if (description) {
          requestBody.markdown_description = description;
        }

        const response = await fetch(`https://api.clickup.com/api/v2/list/${list_id}/task`, {
          method: 'POST',
          headers: {
            Authorization: CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Error creating task: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const createdTask = await response.json();

        const responseLines = formatTaskResponse(createdTask, 'created', {
          list_id, name, description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees
        }, userData);

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error creating task:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error creating task: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

// Write-specific utility functions

function createAssigneeDescription(userData: any): string {
  const user = userData.user;
  return `Optional array of user IDs to assign to the task (defaults to current user: ${user.username} (${user.id}))`;
}

function convertPriorityToNumber(priority: string): number {
  switch (priority) {
    case "urgent": return 1;
    case "high": return 2;
    case "normal": return 3;
    case "low": return 4;
    default: return 3;
  }
}

function convertPriorityToString(priority: number): string {
  const priorityMap = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
  return priorityMap[priority as keyof typeof priorityMap] || 'unknown';
}

function formatTimeEstimate(hours: number): string {
  const displayHours = Math.floor(hours);
  const displayMinutes = Math.round((hours - displayHours) * 60);
  return displayHours > 0 ? `${displayHours}h ${displayMinutes}m` : `${displayMinutes}m`;
}

/**
 * Formats timestamp to ISO string with local timezone (not UTC)
 */
function timestampToIso(timestamp: number | string): string {
  const date = new Date(+timestamp);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  // Calculate timezone offset
  const offset = date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  const sign = offset <= 0 ? '+' : '-';
  const timezoneOffset = sign + String(offsetHours).padStart(2, '0') + ':' + String(offsetMinutes).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}${timezoneOffset}`;
}

function buildTaskRequestBody(params: {
  name?: string;
  description?: string;
  status?: string;
  priority?: string;
  due_date?: string;
  start_date?: string;
  time_estimate?: number;
  tags?: string[];
  assignees?: string[];
  parent_task_id?: string;
}, currentUserId?: string): any {
  const requestBody: any = {};

  if (params.name !== undefined) {
    requestBody.name = params.name;
  }

  if (params.status !== undefined) {
    requestBody.status = params.status;
  }

  if (params.priority !== undefined) {
    requestBody.priority = convertPriorityToNumber(params.priority);
  }

  if (params.due_date !== undefined) {
    requestBody.due_date = new Date(params.due_date).getTime();
  }

  if (params.start_date !== undefined) {
    requestBody.start_date = new Date(params.start_date).getTime();
  }

  if (params.time_estimate !== undefined) {
    requestBody.time_estimate = Math.round(params.time_estimate * 60 * 60 * 1000);
  }

  if (params.tags !== undefined && params.tags.length > 0) {
    requestBody.tags = params.tags;
  }

  if (params.assignees !== undefined) {
    requestBody.assignees = params.assignees;
  } else if (currentUserId) {
    requestBody.assignees = [currentUserId];
  }

  if (params.parent_task_id !== undefined) {
    requestBody.parent = params.parent_task_id;
  }

  return requestBody;
}

function formatTaskResponse(task: any, operation: 'created' | 'updated', params: any, userData: any): string[] {
  const responseLines = [
    `Task ${operation} successfully!`,
    `task_id: ${task.id}`,
    `name: ${task.name}`,
    ...(operation === 'created' ? [`url: ${task.url}`] : []),
    `status: ${task.status?.status || 'Unknown'}`,
    `assignees: ${task.assignees?.map((a: any) => `${a.username} (${a.id})`).join(', ') || 'None'}`,
    ...(operation === 'created' && params.list_id ? [`list_id: ${params.list_id}`] : []),
    ...(operation === 'updated' ? [
      `updated_by: ${userData.user.username} (${userData.user.id})`,
      `updated_at: ${timestampToIso(Date.now())}`
    ] : [])
  ];

  if (params.priority !== undefined || task.priority) {
    const priority = task.priority ? convertPriorityToString(task.priority.priority) :
                    params.priority ? params.priority : 'unknown';
    responseLines.push(`priority: ${priority}`);
  }

  if (params.due_date !== undefined) {
    responseLines.push(`due_date: ${params.due_date}`);
  }

  if (params.start_date !== undefined) {
    responseLines.push(`start_date: ${params.start_date}`);
  }

  if (params.time_estimate !== undefined) {
    responseLines.push(`time_estimate: ${formatTimeEstimate(params.time_estimate)}`);
  }

  if (params.tags !== undefined && params.tags.length > 0) {
    responseLines.push(`tags: ${params.tags.join(', ')}`);
  }

  if (params.parent_task_id !== undefined) {
    responseLines.push(`parent_task_id: ${params.parent_task_id}`);
  }

  return responseLines;
}
