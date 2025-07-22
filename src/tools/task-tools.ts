import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { processClickUpMarkdown, processClickUpText } from "../clickup-text";
import { ContentBlock, DatedContentEvent, ImageMetadataBlock } from "../shared/types";
import { CONFIG } from "../shared/config";
import { isTaskId, getSpaceDetails, getAllTeamMembers } from "../shared/utils";
import { downloadImages } from "../shared/image-processing";

// Read-specific utility functions

export function registerTaskToolsRead(server: McpServer, userData: any) {
  server.tool(
    "getTaskById",
    [
      "Get a ClickUp task with images and comments by ID.",
      "Always use this URL when referencing tasks in conversations or sharing with others.",
      "The response provides complete context including task details, comments, and status history."
    ].join("\n"),
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
    {
      readOnlyHint: true
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
      let processedEventBlocks: (ContentBlock | ImageMetadataBlock)[] = [];
      for (const event of allDatedEvents) {
        processedEventBlocks.push(...event.contentBlocks);
      }

      // 5. Combine task details with processed event blocks
      const allContentBlocks: (ContentBlock | ImageMetadataBlock)[] = [...taskDetailContentBlocks, ...processedEventBlocks];

      // 6. Download images with smart size limiting
      const limitedContent: ContentBlock[] = await downloadImages(allContentBlocks);

      return {
        content: limitedContent,
      };
    }
  );

}

/**
 * Fetch time entries for a specific task (all time, not date-limited for detail view)
 */
async function fetchTaskTimeEntries(taskId: string): Promise<any[]> {
  try {
    // Get all team members for assignee filter
    const teamMembers = await getAllTeamMembers();
    const params = new URLSearchParams({
      task_id: taskId,
      include_location_names: 'true',
      start_date: '0', // overwrite the default 30 days
    });

    if (teamMembers.length > 0) {
      params.append('assignee', teamMembers.join(','));
    }

    const response = await fetch(`https://api.clickup.com/api/v2/team/${CONFIG.teamId}/time_entries?${params}`, {
      headers: { Authorization: CONFIG.apiKey },
    });

    if (!response.ok) {
      console.error(`Error fetching time entries for task ${taskId}: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('Error fetching task time entries:', error);
    return [];
  }
}

async function loadTaskContent(taskId: string): Promise<(ContentBlock | ImageMetadataBlock)[]> {
  const response = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}?include_markdown_description=true&include_subtasks=true`,
    { headers: { Authorization: CONFIG.apiKey } }
  );
  const task = await response.json();

  const [taskMetadata, content] = await Promise.all([
    // Create the task metadata block using the helper functions
    (async () => {
      const timeEntries = await fetchTaskTimeEntries(task.id);
      return await generateTaskMetadata(task, timeEntries, true);
    })(),
    // process markdown and download images
    processClickUpMarkdown(
      task.markdown_description || "",
      task.attachments || []
    ),
  ]);

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

      const commentBodyBlocks: (ContentBlock | ImageMetadataBlock)[] = await processClickUpText(comment.comment);

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
    const uniqueEvents = Array.from(new Map(events.map(event => {
      const firstBlock = event.contentBlocks[0];
      const textKey = firstBlock && 'text' in firstBlock ? firstBlock.text : 'unknown';
      return [`${event.date}-${textKey}`, event];
    })).values());

    return uniqueEvents;
  } catch (error) {
    console.error(`Exception fetching time in status for task ${taskId}:`, error);
    return [];
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
 * Helper function to filter and format time entries for a specific task
 */
function filterTaskTimeEntries(taskId: string, timeEntries: any[]): string | null {
  if (!timeEntries || timeEntries.length === 0) {
    return null;
  }

  // Filter entries for this specific task
  const taskEntries = timeEntries.filter((entry: any) => entry.task?.id === taskId);

  if (taskEntries.length === 0) {
    return null;
  }

  // Group time entries by user (same logic as original getTaskTimeEntries)
  const timeByUser = new Map<string, number>();

  taskEntries.forEach((entry: any) => {
    const username = entry.user?.username || 'Unknown User';
    const currentTime = timeByUser.get(username) || 0;
    const entryDurationMs = parseInt(entry.duration) || 0;
    timeByUser.set(username, currentTime + entryDurationMs);
  });

  // Format results (same logic as original)
  const userTimeEntries: string[] = [];

  for (const [username, totalMs] of timeByUser.entries()) {
    const hours = totalMs / (1000 * 60 * 60);
    const displayHours = Math.floor(hours);
    const displayMinutes = Math.round((hours - displayHours) * 60);
    const timeDisplay = displayHours > 0 ? 
      `${displayHours}h ${displayMinutes}m` : 
      `${displayMinutes}m`;

    userTimeEntries.push(`${username}: ${timeDisplay}`);
  }

  return userTimeEntries.length > 0 ? userTimeEntries.join(', ') : null;
}

/**
 * Helper function to generate consistent task metadata
 */
export async function generateTaskMetadata(task: any, timeEntries?: any[], isDetailView: boolean = false): Promise<ContentBlock> {
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
    `task_url: ${task.url}`,
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

  // Add time booked (tracked time entries) - only if timeEntries provided
  if (timeEntries) {
    const timeBooked = filterTaskTimeEntries(task.id, timeEntries);
    if (timeBooked) {
      const disclaimer = isDetailView ? "" : " (last 30 days)";
      metadataLines.push(`time_booked${disclaimer}: ${timeBooked}`);
    }
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
