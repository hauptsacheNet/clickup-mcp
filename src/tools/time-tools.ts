import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { ContentBlock } from "../shared/types";

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

export function registerTimeTools(server: McpServer) {
  server.tool(
    "bookTime",
    "Books time on a task for the current user. Use decimal hours (e.g., 0.25 for 15 minutes, 0.5 for 30 minutes, 2.5 for 2.5 hours)",
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to book time against"),
      hours: z.number().min(0.01).max(24).describe("Hours to book (decimal format, e.g., 0.25 = 15min, 1.5 = 1h 30min)"),
      description: z.string().optional().describe("Optional description for the time entry"),
      start_time: z.string().optional().describe("Optional start time as ISO date string (e.g., '2024-10-06T09:00:00+02:00', defaults to current time)")
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
          throw new Error(`Error booking time: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const timeEntry = await response.json();

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
        console.error('Error booking time:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error booking time: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "getTaskTimeEntries",
    "Gets all time entries for a specific task",
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to get time entries for"),
      start_date: z.string().optional().describe("Optional start date filter as ISO date string (e.g., '2024-10-06T00:00:00+02:00')"),
      end_date: z.string().optional().describe("Optional end date filter as ISO date string (e.g., '2024-10-06T23:59:59+02:00')")
    },
    async ({ task_id, start_date, end_date }) => {
      try {
        // Build query parameters
        const params = new URLSearchParams({
          task_id: task_id
        });

        if (start_date) {
          params.append('start_date', isoToTimestamp(start_date).toString());
        }

        if (end_date) {
          params.append('end_date', isoToTimestamp(end_date).toString());
        }

        const response = await fetch(`https://api.clickup.com/api/v2/team/${CONFIG.teamId}/time_entries?${params}`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!response.ok) {
          throw new Error(`Error fetching time entries: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        if (!data.data || !Array.isArray(data.data)) {
          return {
            content: [{ type: "text", text: `No time entries found for task ${task_id}.` }],
          };
        }

        // Group time entries by user
        const timeByUser = new Map<string, number>();
        const entriesByUser = new Map<string, any[]>();

        data.data.forEach((entry: any) => {
          const username = entry.user?.username || 'Unknown User';
          const currentTime = timeByUser.get(username) || 0;
          const entryDurationMs = parseInt(entry.duration) || 0;

          timeByUser.set(username, currentTime + entryDurationMs);

          if (!entriesByUser.has(username)) {
            entriesByUser.set(username, []);
          }
          entriesByUser.get(username)!.push(entry);
        });

        // Format results
        const summaryLines: string[] = [`Time entries for task ${task_id}:`];
        let totalTimeMs = 0;

        for (const [username, totalMs] of timeByUser.entries()) {
          const hours = totalMs / (1000 * 60 * 60);
          const displayHours = Math.floor(hours);
          const displayMinutes = Math.round((hours - displayHours) * 60);
          const timeDisplay = displayHours > 0 ? 
            `${displayHours}h ${displayMinutes}m` : 
            `${displayMinutes}m`;

          summaryLines.push(`  ${username}: ${timeDisplay}`);
          totalTimeMs += totalMs;
        }

        const totalHours = totalTimeMs / (1000 * 60 * 60);
        const totalDisplayHours = Math.floor(totalHours);
        const totalDisplayMinutes = Math.round((totalHours - totalDisplayHours) * 60);
        const totalDisplay = totalDisplayHours > 0 ? 
          `${totalDisplayHours}h ${totalDisplayMinutes}m` : 
          `${totalDisplayMinutes}m`;

        summaryLines.push(`Total: ${totalDisplay}`);

        // Create detailed entries if requested
        const detailBlocks: ContentBlock[] = [];
        for (const [username, entries] of entriesByUser.entries()) {
          entries.forEach((entry: any) => {
            const entryHours = (parseInt(entry.duration) || 0) / (1000 * 60 * 60);
            const entryDisplayHours = Math.floor(entryHours);
            const entryDisplayMinutes = Math.round((entryHours - entryDisplayHours) * 60);
            const entryTimeDisplay = entryDisplayHours > 0 ? 
              `${entryDisplayHours}h ${entryDisplayMinutes}m` : 
              `${entryDisplayMinutes}m`;

            detailBlocks.push({
              type: "text" as const,
              text: [
                `entry_id: ${entry.id}`,
                `user: ${username}`,
                `duration: ${entryTimeDisplay}`,
                `start: ${timestampToIso(parseInt(entry.start))}`,
                ...(entry.description ? [`description: ${entry.description}`] : []),
                `billable: ${entry.billable || false}`
              ].join('\n')
            });
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: summaryLines.join('\n')
            },
            ...(detailBlocks.length > 0 ? [
              { type: "text" as const, text: "\nDetailed entries:" },
              ...detailBlocks
            ] : [])
          ],
        };

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
