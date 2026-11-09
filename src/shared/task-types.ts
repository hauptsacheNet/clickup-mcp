import { z } from "zod";
import { CONFIG } from "./config";

const GLOBAL_REFRESH_INTERVAL = 60000; // 60 seconds - that is the rate limit time frame

/** A task type ("custom item") as returned by GET /team/{team_id}/custom_item */
export interface CustomItem {
  id: number;
  name: string;
  name_plural?: string | null;
  description?: string | null;
}

/** Task type parameter: a custom item ID or the task type's name */
export const customItemSchema = z
  .union([z.number().int().min(0), z.string().min(1)])
  .optional()
  .describe(
    "Optional task type (ClickUp 'custom item'): the numeric custom_item_id (e.g. 1006) or the type's name (e.g. \"Bug\", case-insensitive). 0 or \"Task\" is the default task type."
  );

let customItemsPromise: Promise<CustomItem[]> | null = null;

/** The workspace's task types (custom items). */
export function getCustomItems(): Promise<CustomItem[]> {
  if (customItemsPromise) {
    return customItemsPromise;
  }

  const promise = (async () => {
    const response = await fetch(`https://api.clickup.com/api/v2/team/${CONFIG.teamId}/custom_item`, {
      headers: { Authorization: CONFIG.apiKey },
    });
    if (!response.ok) {
      throw new Error(`Error loading task types: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return (data.custom_items || []) as CustomItem[];
  })();

  customItemsPromise = promise;
  promise.catch(() => {
    customItemsPromise = null;
  });
  setTimeout(() => {
    customItemsPromise = null;
  }, GLOBAL_REFRESH_INTERVAL);
  return promise;
}

/**
 * Resolve a task type given by ID or name to its numeric custom_item_id.
 * 0 and "Task" (the built-in default type) need no lookup.
 */
export async function resolveCustomItemId(input: number | string | undefined): Promise<number | undefined> {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input === "number" || /^\d+$/.test(input.trim())) {
    return Number(input);
  }

  const wanted = input.trim().toLowerCase();
  if (wanted === "task") {
    return 0;
  }

  const items = await getCustomItems();
  const match = items.find(
    (item) => item.name?.toLowerCase() === wanted || item.name_plural?.toLowerCase() === wanted
  );
  if (!match) {
    const available = ["Task (0)", ...items.map((item) => `${item.name} (${item.id})`)].join(", ");
    throw new Error(`Unknown task type "${input}". Available task types: ${available}`);
  }
  return match.id;
}

/** Name of a task type for display, e.g. "Bug (custom_item_id: 1006)". */
export async function describeCustomItem(customItemId: number | null | undefined): Promise<string> {
  if (!customItemId) {
    return "Task (custom_item_id: 0)";
  }
  try {
    const items = await getCustomItems();
    const match = items.find((item) => item.id === customItemId);
    if (match) {
      return `${match.name} (custom_item_id: ${customItemId})`;
    }
  } catch (error) {
    console.error("Error loading task types:", error);
  }
  return `custom_item_id: ${customItemId}`;
}
