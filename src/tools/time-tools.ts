import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { getAllTeamMembers } from "../shared/utils";
import { clearTimeEntriesCache } from "./search-tools";

/**
 * Converts ISO date string to Unix timestamp in milliseconds
 */
function isoToTimestamp(isoString: string): number {
  return new Date(isoString).getTime();
}

/**
 * Formats timestamp to ISO string with local timezone (not UTC)
 */
function timestampToIso(timestamp: number): string {
  const date = new Date(timestamp);

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
 * Formats duration in milliseconds to human readable format
 */
function formatDuration(durationMs: number): string {
  const hours = durationMs / (1000 * 60 * 60);
  const displayHours = Math.floor(hours);
  const displayMinutes = Math.round((hours - displayHours) * 60);
  return displayHours > 0 ? `${displayHours}h ${displayMinutes}m` : `${displayMinutes}m`;
}

/**
 * Formats timestamp to simple date and time for entry display
 */
function formatEntryTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

export function registerTimeToolsRead(server: McpServer) {
  server.tool(
    "getTimeEntries",
    "Gets time entries for a specific task or all user's time entries. Returns last 30 days by default if no dates specified.",
    {
      task_id: z.string().min(6).max(9).optional().describe("Optional 6-9 character task ID to filter entries. If not provided, returns all user's time entries."),
      start_date: z.string().optional().describe("Optional start date filter as ISO date string (e.g., '2024-10-06T00:00:00+02:00'). Defaults to 30 days ago."),
      end_date: z.string().optional().describe("Optional end date filter as ISO date string (e.g., '2024-10-06T23:59:59+02:00'). Defaults to current date."),
      list_id: z.string().optional().describe("Optional single list ID to filter time entries by a specific list"),
      space_id: z.string().optional().describe("Optional single space ID to filter time entries by a specific space"),
      include_all_users: z.boolean().optional().describe("Optional flag to include time entries from all team members (default: false, only current user)")
    },
    {
      readOnlyHint: true
    },
    async ({ task_id, start_date, end_date, list_id, space_id, include_all_users }) => {
      try {
        // Build query parameters
        const params = new URLSearchParams();

        if (task_id) {
          params.append('task_id', task_id);
        }

        if (start_date) {
          params.append('start_date', isoToTimestamp(start_date).toString());
        }

        if (end_date) {
          params.append('end_date', isoToTimestamp(end_date).toString());
        }

        // Add single list_id or space_id filter (not both)
        if (list_id) {
          params.append('list_id', list_id);
        } else if (space_id) {
          params.append('space_id', space_id);
        }

        // Always include location names to get list information
        params.append('include_location_names', 'true');

        // Handle include_all_users by fetching all team members and adding them as assignees filter
        // Note: This only works for Workspace Owners/Admins
        if (include_all_users) {
          try {
            const teamMembers = await getAllTeamMembers();
            if (teamMembers.length > 0) {
              params.append('assignee', teamMembers.join(','));
            }
          } catch (error) {
            console.error('Warning: Could not fetch all team members. This feature requires Workspace Owner/Admin permissions.');
            // Continue without all users - will only show current user's entries
          }
        }

        const response = await fetch(`https://api.clickup.com/api/v2/team/${CONFIG.teamId}/time_entries?${params}`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!response.ok) {
          throw new Error(`Error fetching time entries: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return processTimeEntriesData(data, task_id, start_date, end_date, include_all_users);

      } catch (error) {
        console.error('Error fetching time entries:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching time entries: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

/**
 * Process the time entries data and return formatted hierarchical output
 */
function processTimeEntriesData(data: any, task_id?: string, start_date?: string, end_date?: string, include_all_users?: boolean) {
  if (!data.data || !Array.isArray(data.data)) {
    const noEntriesMsg = task_id ? 
      `No time entries found for task ${task_id}.` : 
      'No time entries found.';
    return {
      content: [{ type: "text" as const, text: noEntriesMsg }],
    };
  }

  const filteredEntries = data.data;

  // Create hierarchical structure: List → Task → User → Individual entries
  const hierarchy = new Map<string, {
    name: string;
    id: string;
    totalTime: number;
    tasks: Map<string, {
      name: string;
      id: string;
      totalTime: number;
      users: Map<string, {
        name: string;
        id: string;
        totalTime: number;
        entries: any[];
      }>;
    }>;
  }>();
  let totalTimeMs = 0;

  filteredEntries.forEach((entry: any) => {
    const taskId = entry.task?.id || 'no-task';
    
    // Use location names from include_location_names parameter
    const listId = entry.task_location?.list_id || 'no-list';
    const listName = entry.task_location?.list_name || 'No List';
    const taskName = entry.task?.name || 'No Task';
    const userId = entry.user?.id || 'no-user';
    const userName = entry.user?.username || 'Unknown User';
    
    // Handle running timers (negative duration)
    let entryDurationMs = parseInt(entry.duration) || 0;
    const isRunningTimer = entryDurationMs < 0;
    if (isRunningTimer) {
      // For running timers, calculate current duration from start time
      entryDurationMs = Date.now() - parseInt(entry.start);
    }

    totalTimeMs += entryDurationMs;

    // Initialize list level
    if (!hierarchy.has(listId)) {
      hierarchy.set(listId, {
        name: listName,
        id: listId,
        totalTime: 0,
        tasks: new Map()
      });
    }

    const listData = hierarchy.get(listId)!;
    listData.totalTime += entryDurationMs;

    // Initialize task level
    if (!listData.tasks.has(taskId)) {
      listData.tasks.set(taskId, {
        name: taskName,
        id: taskId,
        totalTime: 0,
        users: new Map()
      });
    }

    const taskData = listData.tasks.get(taskId)!;
    taskData.totalTime += entryDurationMs;

    // Initialize user level
    if (!taskData.users.has(userId)) {
      taskData.users.set(userId, {
        name: userName,
        id: userId,
        totalTime: 0,
        entries: []
      });
    }

    const userData = taskData.users.get(userId)!;
    userData.totalTime += entryDurationMs;
    userData.entries.push(entry);
  });

  // Count total tasks across all lists
  let totalTasks = 0;
  for (const [listId, listData] of hierarchy.entries()) {
    totalTasks += listData.tasks.size;
  }

  // Format the hierarchical output
  const outputLines: string[] = [];
  
  // Header with date range and total
  const dateRange = start_date && end_date ? 
    ` (${start_date.split('T')[0]} to ${end_date.split('T')[0]})` : 
    start_date ? ` (from ${start_date.split('T')[0]})` :
    end_date ? ` (until ${end_date.split('T')[0]})` : '';
  
  outputLines.push(`Time Entries Summary${dateRange}`);
  outputLines.push(`Total: ${formatDuration(totalTimeMs)}`);
  outputLines.push('');

  // Check if result is too large (>100 tasks)
  const TASK_LIMIT = 100;
  const isTruncated = totalTasks > TASK_LIMIT;

  if (isTruncated) {
    // Show only list-level summary
    outputLines.push(`⚠️  Large result detected (${totalTasks} tasks). Showing summary only.`);
    outputLines.push(`💡 Use list_id, space_id, or date filters for detailed view.`);
    outputLines.push('');
    
    for (const [listId, listData] of hierarchy.entries()) {
      const taskCount = listData.tasks.size;
      outputLines.push(`📋 ${listData.name} (List: ${listId}) - ${formatDuration(listData.totalTime)} across ${taskCount} task${taskCount === 1 ? '' : 's'}`);
    }
  } else {
    // Show full hierarchical display
    for (const [listId, listData] of hierarchy.entries()) {
      outputLines.push(`📋 ${listData.name} (List: ${listId}) - ${formatDuration(listData.totalTime)}`);
      
      for (const [taskId, taskData] of listData.tasks.entries()) {
        outputLines.push(`  ├─ 🎯 ${taskData.name} (Task: ${taskId}) - ${formatDuration(taskData.totalTime)}`);
        
        const userEntries = Array.from(taskData.users.entries());
        for (let userIndex = 0; userIndex < userEntries.length; userIndex++) {
          const [userId, userData] = userEntries[userIndex];
          const isLastUser = userIndex === userEntries.length - 1;
          const userPrefix = isLastUser ? '  └─' : '  ├─';
          outputLines.push(`${userPrefix} ${userData.name}: ${formatDuration(userData.totalTime)}`);
          
          // Add individual entries
          userData.entries.forEach((entry: any, entryIndex: number) => {
            const isLastEntry = entryIndex === userData.entries.length - 1;
            const entryPrefix = isLastUser ? 
              (isLastEntry ? '      └─' : '      ├─') :
              (isLastEntry ? '  │   └─' : '  │   ├─');
            
            const entryStart = formatEntryTime(parseInt(entry.start));
            
            // Handle running timers
            const rawDuration = parseInt(entry.duration) || 0;
            const isRunningTimer = rawDuration < 0;
            let entryDuration: string;
            
            if (isRunningTimer) {
              const currentDuration = Date.now() - parseInt(entry.start);
              entryDuration = `${formatDuration(currentDuration)} (running)`;
            } else {
              entryDuration = formatDuration(rawDuration);
            }
            
            outputLines.push(`${entryPrefix} ${entryStart} - ${entryDuration}`);
          });
        }
      }
      outputLines.push('');
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: outputLines.join('\n')
      }
    ],
  };
}

export function registerTimeToolsWrite(server: McpServer) {
  server.tool(
    "createTimeEntry",
    [
      "Creates a time entry (books time) on a task for the current user.",
      "Use decimal hours (e.g., 0.25 for 15 minutes, 0.5 for 30 minutes, 2.5 for 2.5 hours).",
      "IMPORTANT: Before booking time, check the task's status - booking time on tasks in 'backlog', 'closed', or similar inactive states usually doesn't make sense.",
      "Suggest moving the task to an active status like 'in progress' first."
    ].join("\n"),
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to book time against"),
      hours: z.number().min(0.01).max(24).describe("Hours to book (decimal format, e.g., 0.25 = 15min, 1.5 = 1h 30min)"),
      description: z.string().optional().describe("Optional description for the time entry"),
      start_time: z.string().optional().describe("Optional start time as ISO date string (e.g., '2024-10-06T09:00:00+02:00', defaults to current time)")
    },
    {
      readOnlyHint: false
    },
    async ({ task_id, hours, description, start_time }) => {
      try {
        // Convert hours to milliseconds (ClickUp API uses milliseconds)
        const durationMs = Math.round(hours * 60 * 60 * 1000);

        // Convert ISO date to timestamp if provided, otherwise use current time
        const startTimeMs = start_time ? isoToTimestamp(start_time) : Date.now();

        const requestBody = {
          tid: task_id,
          start: startTimeMs,
          duration: durationMs,
          ...(description && { description })
        };

        const response = await fetch(`https://api.clickup.com/api/v2/team/${CONFIG.teamId}/time_entries`, {
          method: 'POST',
          headers: { 
            Authorization: CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Error creating time entry: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const timeEntry = await response.json();

        // Clear time entries cache to ensure fresh data on next search
        clearTimeEntriesCache();

        // Format duration for display
        const displayHours = Math.floor(hours);
        const displayMinutes = Math.round((hours - displayHours) * 60);
        const durationDisplay = displayHours > 0 ? 
          `${displayHours}h ${displayMinutes}m` : 
          `${displayMinutes}m`;

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Time entry created successfully!`,
                `entry_id: ${timeEntry.data?.id || 'N/A'}`,
                `task_id: ${task_id}`,
                `duration: ${durationDisplay}`,
                `start_time: ${timestampToIso(startTimeMs)}`,
                ...(description ? [`description: ${description}`] : []),
                `user: ${timeEntry.data?.user?.username || 'Current user'}`
              ].join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error creating time entry:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error creating time entry: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}
