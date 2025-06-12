import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { ContentBlock } from "../shared/types";

export function registerCreateTools(server: McpServer) {
  server.tool(
    "createTask",
    "Creates a new task in a specific list and assigns it to specified users (defaults to current user). Use getListInfo first to understand the list context and available statuses.",
    {
      list_id: z.string().min(1).describe("The ID of the list where the task will be created"),
      name: z.string().min(1).describe("The name/title of the task"),
      description: z.string().optional().describe("Optional description for the task"),
      priority: z.enum(["urgent", "high", "normal", "low"]).optional().describe("Optional priority level"),
      due_date: z.string().optional().describe("Optional due date as ISO date string (e.g., '2024-10-06T23:59:59+02:00')"),
      start_date: z.string().optional().describe("Optional start date as ISO date string (e.g., '2024-10-06T09:00:00+02:00')"),
      time_estimate: z.number().optional().describe("Optional time estimate in hours (will be converted to milliseconds)"),
      tags: z.array(z.string()).optional().describe("Optional array of tag names"),
      parent: z.string().optional().describe("Optional parent task ID to create this as a subtask"),
      assignees: z.array(z.string()).optional().describe("Optional array of user IDs to assign to the task (defaults to current user)")
    },
    async ({ list_id, name, description, priority, due_date, start_date, time_estimate, tags, parent, assignees }) => {
      try {
        // Get current user info for assignment
        const userResponse = await fetch("https://api.clickup.com/api/v2/user", {
          headers: { Authorization: CONFIG.apiKey },
        });
        
        if (!userResponse.ok) {
          throw new Error(`Error fetching user info: ${userResponse.status} ${userResponse.statusText}`);
        }
        
        const userData = await userResponse.json();
        const currentUserId = userData.user.id;

        // Build request body
        const requestBody: any = {
          name,
          assignees: assignees && assignees.length > 0 ? assignees : [currentUserId], // Use provided assignees or default to current user
        };

        if (description) {
          requestBody.description = description;
        }

        if (priority) {
          requestBody.priority = priority === "urgent" ? 1 : 
                                 priority === "high" ? 2 :
                                 priority === "normal" ? 3 : 4;
        }

        if (due_date) {
          requestBody.due_date = new Date(due_date).getTime();
        }

        if (start_date) {
          requestBody.start_date = new Date(start_date).getTime();
        }

        if (time_estimate) {
          // Convert hours to milliseconds
          requestBody.time_estimate = Math.round(time_estimate * 60 * 60 * 1000);
        }

        if (tags && tags.length > 0) {
          requestBody.tags = tags;
        }

        if (parent) {
          requestBody.parent = parent;
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
        
        // Format response
        const responseLines = [
          `Task created successfully!`,
          `task_id: ${createdTask.id}`,
          `name: ${createdTask.name}`,
          `url: ${createdTask.url}`,
          `status: ${createdTask.status?.status || 'Unknown'}`,
          `assignees: ${createdTask.assignees?.map((a: any) => `${a.username} (${a.id})`).join(', ') || 'None'}`,
          `list_id: ${list_id}`,
        ];

        if (createdTask.priority) {
          const priorityMap = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
          responseLines.push(`priority: ${priorityMap[createdTask.priority.priority as keyof typeof priorityMap] || 'unknown'}`);
        }

        if (due_date) {
          responseLines.push(`due_date: ${due_date}`);
        }

        if (start_date) {
          responseLines.push(`start_date: ${start_date}`);
        }

        if (time_estimate) {
          const hours = Math.floor(time_estimate);
          const minutes = Math.round((time_estimate - hours) * 60);
          responseLines.push(`time_estimate: ${hours}h ${minutes}m`);
        }

        if (tags && tags.length > 0) {
          responseLines.push(`tags: ${tags.join(', ')}`);
        }

        if (parent) {
          responseLines.push(`parent_task: ${parent}`);
        }

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

  server.tool(
    "getCurrentUser",
    "Gets information about the current authenticated user",
    async () => {
      try {
        const response = await fetch("https://api.clickup.com/api/v2/user", {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!response.ok) {
          throw new Error(`Error fetching user info: ${response.status} ${response.statusText}`);
        }

        const userData = await response.json();
        const user = userData.user;

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Current User Information:`,
                `user_id: ${user.id}`,
                `username: ${user.username}`,
                `email: ${user.email}`,
                `color: ${user.color || 'None'}`,
                `profile_picture: ${user.profilePicture || 'None'}`,
                `initials: ${user.initials || 'N/A'}`,
                `week_start_day: ${user.week_start_day || 0}`,
                `global_font_support: ${user.global_font_support || false}`,
                `timezone: ${user.timezone || 'Unknown'}`
              ].join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error fetching current user:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching user info: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}