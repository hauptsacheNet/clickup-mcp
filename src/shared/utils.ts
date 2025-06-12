import {ContentBlock} from "./types";
import {CONFIG} from "./config";
import Fuse from 'fuse.js';

const GLOBAL_REFRESH_INTERVAL = 60000; // 60 seconds - that is the rate limit time frame

/**
 * Checks if a string looks like a valid ClickUp task ID
 * Valid task IDs are 6-9 characters long and contain only alphanumeric characters
 */
export function isTaskId(str: string): boolean {
  // Task IDs are 6-9 characters long and contain only alphanumeric characters
  return /^[a-z0-9]{6,9}$/i.test(str);
}

/**
 * Limits the number of images in the content array, replacing excess images with text placeholders
 * Prioritizes keeping the most recent images (assumes content is ordered with newest items last)
 *
 * @param content Array of content blocks that may contain images
 * @param maxImages Maximum number of images to keep
 * @returns Modified content array with limited images
 */
export function limitImages(content: ContentBlock[], maxImages: number): ContentBlock[] {
  // Count how many images we have
  const imageIndices: number[] = [];

  // Find all image blocks
  content.forEach((block, index) => {
    if (block.type === "image") {
      imageIndices.push(index);
    }
  });

  // If we have fewer images than the limit, return the original content
  if (imageIndices.length <= maxImages) {
    return content;
  }

  // Determine which images to keep (the most recent ones)
  // We want to keep the last 'maxImages' images
  const imagesToRemove = imageIndices.slice(0, imageIndices.length - maxImages);

  // Create a new content array with excess images replaced by text
  return content.map((block, index) => {
    if (block.type === "image" && imagesToRemove.includes(index)) {
      return {
        type: "text" as const,
        text: "[Image removed due to size limitations. Only the most recent images are shown.]",
      };
    }
    return block;
  });
}

const spaceCache = new Map<string, Promise<any>>(); // Global cache for space details promises

/**
 * Function to get space details, using a cache to avoid redundant fetches
 */
export function getSpaceDetails(spaceId: string): Promise<any> {
  if (!spaceId) {
    return Promise.reject(new Error('Invalid space ID'));
  }

  const cachedSpace = spaceCache.get(spaceId);
  if (cachedSpace) {
    return cachedSpace;
  }

  const fetchPromise = fetch(
    `https://api.clickup.com/api/v2/space/${spaceId}`,
    {headers: {Authorization: CONFIG.apiKey}})
    .then(res => {
      if (!res.ok) {
        throw new Error(`Error fetching space ${spaceId}: ${res.status}`);
      }
      return res.json();
    })
    .catch(error => {
      console.error(`Network error fetching space ${spaceId}:`, error);
      throw new Error(`Error fetching space ${spaceId}: ${error}`);
    });

  spaceCache.set(spaceId, fetchPromise);
  return fetchPromise;
}

// Task search index management
const taskIndices: Map<string, Fuse<any>> = new Map();

/**
 * Get or create a task search index with specified filters
 */
export async function getTaskSearchIndex(
  space_ids?: string[],
  list_ids?: string[],
  assignees?: string[]
): Promise<Fuse<any> | null> {
  // Create cache key from sorted filter arrays
  const key = JSON.stringify({
    space_ids: space_ids?.sort(),
    list_ids: list_ids?.sort(),
    assignees: assignees?.sort()
  });

  // Check for existing valid index
  const cachedIndex = taskIndices.get(key);
  if (cachedIndex) {
    return cachedIndex;
  }

  // Fetch tasks with specified filters
  console.error(`Refreshing task index for filters: ${key}`);
  const tasks = await fetchTasks(space_ids, list_ids, assignees);
  const index = createFuseIndex(tasks);

  // Store with auto-cleanup
  taskIndices.set(key, index);
  setTimeout(() => {
    taskIndices.delete(key);
    console.error(`Auto-cleaned index for filters: ${key}`);
  }, GLOBAL_REFRESH_INTERVAL);

  console.error(`Task index created with ${tasks.length} tasks`);
  return index;
}

/**
 * Fetch tasks using team endpoint with dynamic filters
 */
async function fetchTasks(
  space_ids?: string[],
  list_ids?: string[],
  assignees?: string[]
): Promise<any[]> {
  const queryParams = ['order_by=updated', 'subtasks=true'];

  // Add filter parameters
  if (space_ids?.length) {
    space_ids.forEach(id => queryParams.push(`space_ids[]=${id}`));
  }
  if (list_ids?.length) {
    list_ids.forEach(id => queryParams.push(`list_ids[]=${id}`));
  }
  if (assignees?.length) {
    assignees.forEach(id => queryParams.push(`assignees[]=${id}`));
  }

  const queryString = queryParams.join('&');

  // Fetch multiple pages in parallel
  const maxPages = space_ids?.length || list_ids?.length || assignees?.length ? 10 : 30; // Fewer pages for filtered searches
  const taskListsPromises = [...Array(maxPages)].map(async (_, i) => {
    const url = `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/task?${queryString}&page=${i}`;
    try {
      const res = await fetch(url, {headers: {Authorization: CONFIG.apiKey}});
      return await res.json();
    } catch (e) {
      console.error(`Error fetching page ${i}:`, e);
      return {tasks: []};
    }
  });

  const taskLists = await Promise.all(taskListsPromises);
  return taskLists.flatMap(taskList => taskList.tasks || []);
}

/**
 * Create a Fuse index from tasks array
 */
function createFuseIndex(tasks: any[]): Fuse<any> {
  return new Fuse(tasks, {
    keys: [
      {name: 'name', weight: 0.7},
      {name: 'id', weight: 0.6},
      {name: 'text_content', weight: 0.5},
      {name: 'tags.name', weight: 0.4},
      {name: 'assignees.username', weight: 0.4},
      {name: 'list.name', weight: 0.3},
      {name: 'folder.name', weight: 0.2},
      {name: 'space.name', weight: 0.1}
    ],
    includeScore: true,
    threshold: 0.4,
    minMatchCharLength: 2,
  });
}
