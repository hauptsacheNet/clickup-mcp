import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { CLICKUP_API_BASE, CLICKUP_TASK_PAGE_SIZE, LIST_TASKS_BY_STATUS_TOOL } from "./settings";

export type TaskPage = { tasks: any[]; nextPage?: number };

export function listTasksUrl(listId: string, statuses: string[], page: number): string {
  const params = new URLSearchParams({ page: String(page) });
  // Without statuses ClickUp returns the open ones; closed tasks are asked for only by name.
  if (statuses.length) {
    statuses.forEach((status) => params.append("statuses[]", status));
    params.set("include_closed", "true");
  }
  return `${CLICKUP_API_BASE}/list/${encodeURIComponent(listId)}/task?${params}`;
}

export async function fetchTasksByStatus(listId: string, statuses: string[], page: number): Promise<TaskPage> {
  const response = await fetch(listTasksUrl(listId, statuses, page), {
    headers: { Authorization: CONFIG.apiKey },
  });
  if (!response.ok) {
    throw new Error(`Error fetching tasks of list ${listId}: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  // A missing last_page cannot prove more pages exist, so it ends the listing.
  return data.last_page === false ? { tasks, nextPage: page + 1 } : { tasks };
}

export function formatTask(task: any): string {
  const assignees = (task.assignees || []).map((a: any) => `${a.username} (user_id: ${a.id})`).join(", ");
  return [
    `- ${task.name} (task_id: ${task.id}${task.custom_id ? `, custom_id: ${task.custom_id}` : ""})`,
    `  status: ${task.status?.status ?? "unknown"}`,
    `  assignees: ${assignees || "none"}`,
    `  url: ${task.url}`,
  ].join("\n");
}

export function formatTaskPage(listId: string, statuses: string[], page: number, result: TaskPage): string {
  const header = [
    `list_id: ${listId}`,
    `statuses: ${statuses.length ? statuses.join(", ") : "all open"}`,
    `page: ${page}`,
    `tasks: ${result.tasks.length}`,
    result.nextPage === undefined ? "nextPage: none (last page)" : `nextPage: ${result.nextPage}`,
  ];
  return [...header, ...result.tasks.map(formatTask)].join("\n");
}

export function registerListByStatusTool(server: McpServer) {
  server.tool(
    LIST_TASKS_BY_STATUS_TOOL,
    [
      `Lists the tasks of one list whose status is one of the given statuses, ${CLICKUP_TASK_PAGE_SIZE} tasks per page.`,
      "Closed statuses are included when named. An empty statuses list returns all open tasks.",
      "When the result shows a nextPage number, call again with that page to get the rest.",
    ].join("\n"),
    {
      list_id: z.string().min(1).describe("The list ID to read tasks from"),
      statuses: z.array(z.string().min(1)).default([]).describe("Status names to match, e.g. [\"in progress\", \"done\"]"),
      page: z.number().int().min(0).default(0).describe("Page number, starting at 0"),
    },
    { readOnlyHint: true },
    async ({ list_id, statuses, page }) => {
      try {
        const result = await fetchTasksByStatus(list_id, statuses, page);
        return { content: [{ type: "text" as const, text: formatTaskPage(list_id, statuses, page, result) }] };
      } catch (error) {
        console.error("Error listing tasks by status:", error);
        return {
          content: [{ type: "text" as const, text: `Error listing tasks by status: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
