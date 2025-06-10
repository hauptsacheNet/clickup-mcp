import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Fuse from 'fuse.js';
import { processClickUpMarkdown, processClickUpText } from "../clickup-text";
import { ContentBlock, DatedContentEvent } from "../shared/types";
import { CONFIG } from "../shared/config";
import { isTaskId, limitImages, getSpaceDetails } from "../shared/utils";

let taskSearchIndex: Fuse<any> | null = null;
let lastIndexUpdateTime = 0;
const INDEX_REFRESH_INTERVAL = 60000; // 60 seconds
const MAX_SEARCH_RESULTS = 50;

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
    "updateTaskStatus",
    "Updates the status of a task. Only works if the current user is assigned to the task.",
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to update"),
      status: z.string().min(1).describe("The new status name (e.g., 'in progress', 'done', 'review')")
    },
    async ({ task_id, status }) => {
      try {
        // First, get current user info
        const userResponse = await fetch("https://api.clickup.com/api/v2/user", {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!userResponse.ok) {
          throw new Error(`Error fetching user info: ${userResponse.status} ${userResponse.statusText}`);
        }

        const userData = await userResponse.json();
        const currentUserId = userData.user.id;

        // Get task details to check if user is assigned
        const taskResponse = await fetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!taskResponse.ok) {
          throw new Error(`Error fetching task: ${taskResponse.status} ${taskResponse.statusText}`);
        }

        const taskData = await taskResponse.json();

        // Check if current user is assigned to this task
        const isAssigned = taskData.assignees?.some((assignee: any) => assignee.id.toString() === currentUserId.toString());

        if (!isAssigned) {
          return {
            content: [
              {
                type: "text",
                text: `Permission denied: You are not assigned to task ${task_id}. Only assigned users can update task status.`,
              },
            ],
          };
        }

        // Update the task status
        const updateBody = {
          status: status
        };

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
          throw new Error(`Error updating task status: ${updateResponse.status} ${updateResponse.statusText} - ${JSON.stringify(errorData)}`);
        }

        const updatedTask = await updateResponse.json();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Task status updated successfully!`,
                `task_id: ${task_id}`,
                `name: ${updatedTask.name}`,
                `previous_status: ${taskData.status?.status || 'Unknown'}`,
                `new_status: ${updatedTask.status?.status || status}`,
                `updated_by: ${userData.user.username}`,
                `updated_at: ${timestampToIso(Date.now())}`
              ].join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error updating task status:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating task status: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
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
  const seconds = String(date.getSeconds()).padStart(2, '0');

  // Calculate timezone offset
  const offset = date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  const sign = offset <= 0 ? '+' : '-';
  const timezoneOffset = sign + String(offsetHours).padStart(2, '0') + ':' + String(offsetMinutes).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${timezoneOffset}`;
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
    `creator: ${task.creator.username}`,
    `assignee: ${task.assignees.map((a: any) => a.username).join(', ')}`,
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
