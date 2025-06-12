import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { processClickUpMarkdown, processClickUpText } from "../clickup-text";
import { ContentBlock, DatedContentEvent } from "../shared/types";
import { CONFIG } from "../shared/config";
import { isTaskId, limitImages, getSpaceDetails } from "../shared/utils";

export function registerTaskTools(server: McpServer) {
  server.tool(
    "getTaskById",
    "Get a Clickup task with images and comments by ID",
    {
      id: z
        .string()
        .min(6)
        .max(9)
        .refine(val => isTaskId(val), {
          message: "Task ID must be 6-9 alphanumeric characters only"
        })
        .describe(
          `The 6-9 character ID of the task to get without a prefix like "#", "CU-" or "https://app.clickup.com/t/"`
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


  server.tool(
    "addComment",
    "Adds a comment to a specific task",
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
    "Updates various aspects of an existing task. Use getListInfo first to see valid status options.",
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to update"),
      name: z.string().optional().describe("Optional new name/title for the task"),
      description: z.string().optional().describe("Optional new description for the task"),
      status: z.string().optional().describe("Optional new status name - use getListInfo to see valid options"),
      priority: z.enum(["urgent", "high", "normal", "low"]).optional().describe("Optional new priority level"),
      due_date: z.string().optional().describe("Optional new due date as ISO date string (e.g., '2024-10-06T23:59:59+02:00')"),
      start_date: z.string().optional().describe("Optional new start date as ISO date string (e.g., '2024-10-06T09:00:00+02:00')"),
      time_estimate: z.number().optional().describe("Optional new time estimate in hours (will be converted to milliseconds)"),
      tags: z.array(z.string()).optional().describe("Optional array of tag names (will replace existing tags)"),
      assignees: z.array(z.string()).optional().describe("Optional array of user IDs to assign to the task")
    },
    async ({ task_id, name, description, status, priority, due_date, start_date, time_estimate, tags, assignees }) => {
      try {
        // Get current user info
        const userResponse = await fetch("https://api.clickup.com/api/v2/user", {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!userResponse.ok) {
          throw new Error(`Error fetching user info: ${userResponse.status} ${userResponse.statusText}`);
        }

        const userData = await userResponse.json();

        // Get task details to get current state
        const taskResponse = await fetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!taskResponse.ok) {
          throw new Error(`Error fetching task: ${taskResponse.status} ${taskResponse.statusText}`);
        }

        const taskData = await taskResponse.json();

        // Build update body with only provided fields
        const updateBody: any = {};

        if (name !== undefined) {
          updateBody.name = name;
        }

        if (description !== undefined) {
          updateBody.description = description;
        }

        if (status !== undefined) {
          updateBody.status = status;
        }

        if (priority !== undefined) {
          updateBody.priority = priority === "urgent" ? 1 : 
                                 priority === "high" ? 2 :
                                 priority === "normal" ? 3 : 4;
        }

        if (due_date !== undefined) {
          updateBody.due_date = new Date(due_date).getTime();
        }

        if (start_date !== undefined) {
          updateBody.start_date = new Date(start_date).getTime();
        }

        if (time_estimate !== undefined) {
          // Convert hours to milliseconds
          updateBody.time_estimate = Math.round(time_estimate * 60 * 60 * 1000);
        }

        if (tags !== undefined && tags.length > 0) {
          updateBody.tags = tags;
        }

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

        // Build response
        const responseLines = [
          `Task updated successfully!`,
          `task_id: ${task_id}`,
          `name: ${updatedTask.name}`,
          `status: ${updatedTask.status?.status || 'Unknown'}`,
          `updated_by: ${userData.user.username}`,
          `updated_at: ${timestampToIso(Date.now())}`
        ];

        if (priority !== undefined && updatedTask.priority) {
          const priorityMap = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
          responseLines.push(`priority: ${priorityMap[updatedTask.priority.priority as keyof typeof priorityMap] || 'unknown'}`);
        }

        if (due_date !== undefined) {
          responseLines.push(`due_date: ${due_date}`);
        }

        if (start_date !== undefined) {
          responseLines.push(`start_date: ${start_date}`);
        }

        if (time_estimate !== undefined) {
          const hours = Math.floor(time_estimate);
          const minutes = Math.round((time_estimate - hours) * 60);
          responseLines.push(`time_estimate: ${hours}h ${minutes}m`);
        }

        if (tags !== undefined && tags.length > 0) {
          responseLines.push(`tags: ${tags.join(', ')}`);
        }

        if (assignees !== undefined) {
          responseLines.push(`assignees: ${updatedTask.assignees?.map((a: any) => a.username).join(', ') || 'None'}`);
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

}



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
        text: `Comment by ${comment.user.username} on ${timestampToIso(comment.date)}:`,
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
          text: `Status set to '${entry.status}' on ${timestampToIso(entry.total_time.since)}`,
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
 * Helper function to fetch time entries for a task
 */
async function getTaskTimeEntries(taskId: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.clickup.com/api/v2/team/${CONFIG.teamId}/time_entries?task_id=${taskId}`, {
      headers: { Authorization: CONFIG.apiKey },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      return null;
    }

    // Group time entries by user
    const timeByUser = new Map<string, number>();

    data.data.forEach((entry: any) => {
      const username = entry.user?.username || 'Unknown User';
      const currentTime = timeByUser.get(username) || 0;
      const entryDurationMs = parseInt(entry.duration) || 0;
      timeByUser.set(username, currentTime + entryDurationMs);
    });

    // Format results
    const userTimeEntries: string[] = [];
    let totalTimeMs = 0;

    for (const [username, totalMs] of timeByUser.entries()) {
      const hours = totalMs / (1000 * 60 * 60);
      const displayHours = Math.floor(hours);
      const displayMinutes = Math.round((hours - displayHours) * 60);
      const timeDisplay = displayHours > 0 ? 
        `${displayHours}h ${displayMinutes}m` : 
        `${displayMinutes}m`;

      userTimeEntries.push(`${username}: ${timeDisplay}`);
      totalTimeMs += totalMs;
    }

    if (userTimeEntries.length === 0) {
      return null;
    }

    return userTimeEntries.join(', ');
  } catch (error) {
    console.error(`Error fetching time entries for task ${taskId}:`, error);
    return null;
  }
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

/**
 * Helper function to generate consistent task metadata
 */
export async function generateTaskMetadata(task: any): Promise<ContentBlock> {
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
    `date_created: ${timestampToIso(task.date_created)}`,
    `date_updated: ${timestampToIso(task.date_updated)}`,
    `creator: ${task.creator.username} (${task.creator.id})`,
    `assignee: ${task.assignees.map((a: any) => `${a.username} (${a.id})`).join(', ')}`,
    `list: ${task.list.name} (${task.list.id})`,
    `space: ${spaceName} (${spaceIdForDisplay})`,
  ];

  // Add priority if it exists
  if (task.priority !== undefined && task.priority !== null) {
    const priorityName = task.priority.priority || 'none';
    metadataLines.push(`priority: ${priorityName}`);
  }

  // Add due date if it exists
  if (task.due_date) {
    metadataLines.push(`due_date: ${timestampToIso(task.due_date)}`);
  }

  // Add start date if it exists
  if (task.start_date) {
    metadataLines.push(`start_date: ${timestampToIso(task.start_date)}`);
  }

  // Add time estimate if it exists
  if (task.time_estimate) {
    const hours = Math.floor(task.time_estimate / 3600000);
    const minutes = Math.floor((task.time_estimate % 3600000) / 60000);
    metadataLines.push(`time_estimate: ${hours}h ${minutes}m`);
  }

  // Add time booked (tracked time entries)
  const timeBooked = await getTaskTimeEntries(task.id);
  if (timeBooked) {
    metadataLines.push(`time_booked: ${timeBooked}`);
  }

  // Add tags if they exist
  if (task.tags && task.tags.length > 0) {
    metadataLines.push(`tags: ${task.tags.map((t: any) => t.name).join(', ')}`);
  }

  // Add watchers if they exist
  if (task.watchers && task.watchers.length > 0) {
    metadataLines.push(`watchers: ${task.watchers.map((w: any) => w.username).join(', ')}`);
  }

  // Add parent task information if it exists
  if (typeof task.parent === "string") {
    metadataLines.push(`parent_task_id: ${task.parent}`);
  }

  // Add child task information if it exists
  if (task.subtasks && task.subtasks.length > 0) {
    metadataLines.push(`child_task_ids: ${task.subtasks.map((st: any) => st.id).join(', ')}`);
  }

  // Add task URL
  metadataLines.push(`url: ${task.url}`);

  // Add archived status if true
  if (task.archived) {
    metadataLines.push(`archived: true`);
  }

  // Add custom fields if they exist
  if (task.custom_fields && task.custom_fields.length > 0) {
    task.custom_fields.forEach((field: any) => {
      if (field.value !== undefined && field.value !== null && field.value !== '') {
        const fieldName = field.name.toLowerCase().replace(/\s+/g, '_');
        let fieldValue = field.value;

        // Handle different custom field types
        if (field.type === 'drop_down' && typeof field.value === 'number') {
          // For dropdown fields, find the selected option
          const selectedOption = field.type_config?.options?.find((opt: any) => opt.orderindex === field.value);
          fieldValue = selectedOption?.name || field.value;
        } else if (Array.isArray(field.value)) {
          // For multi-select or array values
          fieldValue = field.value.map((v: any) => v.name || v).join(', ');
        } else if (typeof field.value === 'object') {
          // For object values (like users), extract meaningful data
          fieldValue = field.value.username || field.value.name || JSON.stringify(field.value);
        }

        metadataLines.push(`custom_${fieldName}: ${fieldValue}`);
      }
    });
  }

  return {
    type: "text" as const,
    text: metadataLines.join("\n"),
  };
}
