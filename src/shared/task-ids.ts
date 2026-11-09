import { z } from "zod";
import { CONFIG } from "./config";
import { isTaskId } from "./utils";

const GLOBAL_REFRESH_INTERVAL = 60000; // 60 seconds - that is the rate limit time frame

/**
 * Checks if a string looks like a ClickUp Custom Task ID (e.g. "ENG-302", "DEV-1234").
 *
 * Workspaces with the Custom Task IDs ClickApp give every task a prefix + counter ID
 * in addition to its generated ID. The prefix is letters/digits starting with a letter,
 * the counter is numeric, and the two are always joined by a hyphen - which is what
 * keeps them apart from generated IDs (those are bare alphanumerics, see isTaskId).
 */
export function isCustomTaskId(str: string): boolean {
  return /^[a-z][a-z0-9]{0,15}-\d{1,10}$/i.test(str);
}

/**
 * Zod schema for any parameter that takes a task: a generated task ID ("86ey1qwck")
 * or a Custom Task ID ("ENG-302"). Resolve the value with resolveTaskId before use.
 */
export function taskIdSchema(description: string) {
  return z
    .string()
    .min(1)
    .max(27)
    .refine((val) => isTaskId(val) || isCustomTaskId(val), {
      message:
        'Task ID must be a 6-16 character alphanumeric task ID (e.g. "86ey1qwck") or a Custom Task ID (e.g. "ENG-302")',
    })
    .describe(description);
}

export const TASK_ID_FORMAT_HINT =
  'the task ID without a prefix like "#", "CU-" or "https://app.clickup.com/t/" - either the generated ID (e.g. "86ey1qwck") or the workspace\'s Custom Task ID (e.g. "ENG-302")';

const customTaskIdCache = new Map<string, Promise<string>>();

/**
 * Turn a task reference into ClickUp's generated task ID.
 *
 * Generated IDs are returned unchanged without an API call. Custom Task IDs are looked
 * up once via `GET /task/{id}?custom_task_ids=true&team_id=...` (the API's documented
 * way to address a task by custom ID) and every later call in the same tool uses the
 * generated ID, so the endpoints that do not accept custom_task_ids (comment replies,
 * time entries, attachments) work as well. The lookup promise is cached for a minute.
 */
export function resolveTaskId(id: string): Promise<string> {
  if (!isCustomTaskId(id)) {
    return Promise.resolve(id);
  }

  const key = id.toUpperCase();
  const cached = customTaskIdCache.get(key);
  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({ custom_task_ids: "true", team_id: CONFIG.teamId });
  const promise = (async () => {
    const response = await fetch(
      `https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}?${params}`,
      { headers: { Authorization: CONFIG.apiKey } }
    );
    if (!response.ok) {
      throw new Error(
        `Custom Task ID "${id}" could not be resolved in workspace ${CONFIG.teamId}: ${response.status} ${response.statusText}. ` +
          `Check the ID and that the Custom Task IDs ClickApp is enabled.`
      );
    }
    const task = await response.json();
    if (!task || typeof task.id !== "string") {
      throw new Error(`Custom Task ID "${id}" did not resolve to a task`);
    }
    return task.id as string;
  })();

  customTaskIdCache.set(key, promise);
  // Failed lookups must not stick - drop them right away so a retry asks again.
  promise.catch(() => customTaskIdCache.delete(key));
  setTimeout(() => customTaskIdCache.delete(key), GLOBAL_REFRESH_INTERVAL);
  return promise;
}

/** resolveTaskId for an optional list of task references (dependencies, links). */
export async function resolveTaskIds(ids: string[] | undefined): Promise<string[] | undefined> {
  return ids === undefined ? undefined : Promise.all(ids.map(resolveTaskId));
}
