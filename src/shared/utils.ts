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

// Cache for current user info to avoid repeated API calls and race conditions
let cachedUserPromise: Promise<any> | null = null;

/**
 * Get current authenticated user information from ClickUp API
 * Caches the promise to prevent race conditions on concurrent calls
 */
export async function getCurrentUser() {
  // Return cached promise if available
  if (cachedUserPromise) {
    return cachedUserPromise;
  }

  // Create the fetch promise
  const fetchPromise = (async () => {
    const userResponse = await fetch("https://api.clickup.com/api/v2/user", {
      headers: { Authorization: CONFIG.apiKey },
    });

    if (!userResponse.ok) {
      throw new Error(`Error fetching user info: ${userResponse.status} ${userResponse.statusText}`);
    }

    return await userResponse.json();
  })();

  // Cache the promise
  cachedUserPromise = fetchPromise;
  
  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    cachedUserPromise = null;
    console.error(`Auto-cleaned user data cache`);
  }, GLOBAL_REFRESH_INTERVAL);
  
  return fetchPromise;
}

// Re-export image processing functions for backward compatibility
export { downloadImages } from "./image-processing";

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

// Task search index management - cache promises to prevent race conditions
const taskIndices: Map<string, Promise<Fuse<any>>> = new Map();

/**
 * Get or create a task search index with specified filters
 * Caches promises to prevent race conditions on concurrent calls
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

  // Check for existing valid index promise
  const cachedPromise = taskIndices.get(key);
  if (cachedPromise) {
    return cachedPromise;
  }

  // Create the fetch promise
  const fetchPromise = (async (): Promise<Fuse<any>> => {
    console.error(`Refreshing task index for filters: ${key}`);
    const tasks = await fetchTasks(space_ids, list_ids, assignees);
    const index = createFuseIndex(tasks);
    console.error(`Task index created with ${tasks.length} tasks`);
    return index;
  })();

  // Store promise with auto-cleanup
  taskIndices.set(key, fetchPromise);
  setTimeout(() => {
    taskIndices.delete(key);
    console.error(`Auto-cleaned index for filters: ${key}`);
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
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
    findAllMatches: true,
    includeScore: true,
    minMatchCharLength: 2,
    threshold: 0.4,
  });
}

// ===== LINK UTILITIES =====

/**
 * Generate a ClickUp task URL from a task ID
 */
export function generateTaskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${taskId}`;
}

/**
 * Generate a ClickUp list URL from a list ID
 */
export function generateListUrl(listId: string): string {
  return `https://app.clickup.com/v/l/${listId}`;
}

/**
 * Generate a ClickUp space URL from a space ID
 */
export function generateSpaceUrl(spaceId: string): string {
  return `https://app.clickup.com/v/s/${spaceId}`;
}

/**
 * Generate a ClickUp folder URL from a folder ID
 */
export function generateFolderUrl(folderId: string): string {
  return `https://app.clickup.com/v/f/${folderId}`;
}

/**
 * Format a ClickUp task link as markdown
 */
export function formatTaskLink(taskId: string, taskName?: string): string {
  const url = generateTaskUrl(taskId);
  const displayText = taskName ? `${taskName} (${taskId})` : taskId;
  return `[${displayText}](${url})`;
}

/**
 * Format a ClickUp list link as markdown
 */
export function formatListLink(listId: string, listName?: string): string {
  const url = generateListUrl(listId);
  const displayText = listName ? `${listName} (${listId})` : listId;
  return `[${displayText}](${url})`;
}

/**
 * Format a ClickUp space link as markdown
 */
export function formatSpaceLink(spaceId: string, spaceName?: string): string {
  const url = generateSpaceUrl(spaceId);
  const displayText = spaceName ? `${spaceName} (${spaceId})` : spaceId;
  return `[${displayText}](${url})`;
}

/**
 * Extract task ID from a ClickUp URL
 */
export function extractTaskIdFromUrl(url: string): string | null {
  const match = url.match(/https?:\/\/app\.clickup\.com\/t\/([a-z0-9]{6,9})/i);
  return match ? match[1] : null;
}

/**
 * Validate if a string is a valid ClickUp URL
 */
export function isClickUpUrl(url: string): boolean {
  return /^https?:\/\/app\.clickup\.com\//.test(url);
}

/**
 * Format a prominent link section for responses
 */
export function formatLinksSection(links: { text: string; url: string }[]): string {
  if (links.length === 0) return '';
  
  const linkLines = links.map(link => `🔗 [${link.text}](${link.url})`);
  return `\n\n**📌 Quick Links:**\n${linkLines.join('\n')}`;
}

// Space search index cache - cache promise to prevent race conditions
let spaceSearchIndexPromise: Promise<Fuse<any> | null> | null = null;

/**
 * Get or refresh the space search index
 * Caches promise to prevent race conditions on concurrent calls
 */
export async function getSpaceSearchIndex(): Promise<Fuse<any> | null> {
  // Return cached promise if available
  if (spaceSearchIndexPromise) {
    return spaceSearchIndexPromise;
  }

  // Create the fetch promise
  const fetchPromise = (async (): Promise<Fuse<any> | null> => {
    try {
      const url = `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/space`;
      const response = await fetch(url, {
        headers: { Authorization: CONFIG.apiKey },
      });

      if (!response.ok) {
        throw new Error(`Error fetching spaces: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const spacesData = data.spaces || [];

      // Create Fuse search index
      return new Fuse(spacesData as any[], {
        keys: [
          { name: 'name', weight: 0.7 },
          { name: 'id', weight: 0.6 }
        ],
        includeScore: true,
        threshold: 0.4,
        minMatchCharLength: 1,
      });
    } catch (error) {
      console.error('Error creating space search index:', error);
      return null;
    }
  })();

  // Cache the promise
  spaceSearchIndexPromise = fetchPromise;

  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    spaceSearchIndexPromise = null;
    console.error('Auto-cleaned space search index');
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}


const listCache = new Map<string, Promise<any>>(); // Cache for space lists/folders

/**
 * Get lists and folders for a specific space with caching
 */
export async function getSpaceContent(spaceId: string): Promise<{ lists: any[], folders: any[] }> {
  const cacheKey = `space-content-${spaceId}`;
  
  // Check cache first
  const cachedContent = listCache.get(cacheKey);
  if (cachedContent) {
    return cachedContent;
  }

  // Fetch content with parallel requests
  const fetchPromise = (async () => {
    try {
      const [foldersResponse, listsResponse] = await Promise.all([
        fetch(`https://api.clickup.com/api/v2/space/${spaceId}/folder`, {
          headers: { Authorization: CONFIG.apiKey },
        }),
        fetch(`https://api.clickup.com/api/v2/space/${spaceId}/list`, {
          headers: { Authorization: CONFIG.apiKey },
        })
      ]);

      const folders = foldersResponse.ok ? 
        (await foldersResponse.json()).folders || [] : [];
      const lists = listsResponse.ok ? 
        (await listsResponse.json()).lists || [] : [];

      // For each folder, also fetch its lists
      const folderListPromises = folders.map(async (folder: any) => {
        try {
          const folderListResponse = await fetch(
            `https://api.clickup.com/api/v2/folder/${folder.id}/list`,
            { headers: { Authorization: CONFIG.apiKey } }
          );
          if (folderListResponse.ok) {
            const folderListData = await folderListResponse.json();
            folder.lists = folderListData.lists || [];
          }
          return folder;
        } catch (error) {
          console.error(`Error fetching lists for folder ${folder.id}:`, error);
          folder.lists = [];
          return folder;
        }
      });

      const foldersWithLists = await Promise.all(folderListPromises);

      return { lists, folders: foldersWithLists };
    } catch (error) {
      console.error(`Error fetching space content for ${spaceId}:`, error);
      return { lists: [], folders: [] };
    }
  })();

  // Cache the promise
  listCache.set(cacheKey, fetchPromise);
  
  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    listCache.delete(cacheKey);
    console.error(`Auto-cleaned space content cache for ${spaceId}`);
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}

// Cache for team members to avoid repeated API calls and race conditions
let cachedTeamMembersPromise: Promise<string[]> | null = null;

/**
 * Gets all team members from ClickUp API with caching
 */
export async function getAllTeamMembers(): Promise<string[]> {
  // Return cached promise if available
  if (cachedTeamMembersPromise) {
    return cachedTeamMembersPromise;
  }

  // Create the fetch promise
  const fetchPromise = (async (): Promise<string[]> => {
    try {
      const response = await fetch(`https://api.clickup.com/api/v2/team`, {
        headers: { Authorization: CONFIG.apiKey },
      });

      if (!response.ok) {
        console.error(`Error fetching teams: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json();
      if (!data.teams || !Array.isArray(data.teams)) {
        return [];
      }

      // Find the team that matches our configured team ID and extract all user IDs
      const currentTeam = data.teams.find((team: any) => team.id === CONFIG.teamId);
      if (!currentTeam || !currentTeam.members || !Array.isArray(currentTeam.members)) {
        console.error(`Team ${CONFIG.teamId} not found or has no members`);
        return [];
      }

      return currentTeam.members.map((member: any) => member.user?.id).filter(Boolean);
    } catch (error) {
      console.error('Error fetching team members:', error);
      return [];
    }
  })();

  // Cache the promise
  cachedTeamMembersPromise = fetchPromise;
  
  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    cachedTeamMembersPromise = null;
    console.error(`Auto-cleaned team members cache`);
  }, GLOBAL_REFRESH_INTERVAL);
  
  return fetchPromise;
}

/**
 * Performs multi-term search with aggressive boosting for items matching multiple terms
 * @param searchIndex Fuse search index to search within
 * @param terms Array of search terms
 * @returns Array of items sorted by relevance (multi-term matches ranked higher)
 */
export async function performMultiTermSearch<T>(
  searchIndex: Fuse<T>,
  terms: string[]
): Promise<T[]> {
  // Filter valid search terms
  const validTerms = terms.filter(term => term && term.trim().length > 0);
  if (validTerms.length === 0) {
    return [];
  }

  // Track multiple matches per item for aggressive boosting
  const itemMatches = new Map<string, {
    item: T,
    scores: number[],
    matchedTerms: string[]
  }>();

  // Collect all matches for each term
  validTerms.forEach(term => {
    const results = searchIndex.search(term);
    results.forEach(result => {
      if (result.item && typeof (result.item as any).id === 'string') {
        const itemId = (result.item as any).id;
        const currentScore = result.score ?? 1;
        const existing = itemMatches.get(itemId);
        
        if (!existing) {
          itemMatches.set(itemId, {
            item: result.item,
            scores: [currentScore],
            matchedTerms: [term]
          });
        } else {
          existing.scores.push(currentScore);
          existing.matchedTerms.push(term);
        }
      }
    });
  });

  // Calculate aggressively boosted scores for multi-term matches
  const uniqueResults = new Map<string, { item: T, score: number }>();
  itemMatches.forEach((match, itemId) => {
    const bestScore = Math.min(...match.scores);
    const matchCount = match.scores.length;
    const totalTerms = validTerms.length;
    
    // Aggressive multi-term boost: exponential improvement for multiple matches
    // 1 match: base score
    // 2+ matches: exponentially better score based on match ratio
    const matchRatio = matchCount / totalTerms;
    const boostFactor = Math.pow(0.1, matchRatio * 4); // Very aggressive boost
    const finalScore = bestScore * boostFactor;
    
    uniqueResults.set(itemId, {
      item: match.item,
      score: finalScore
    });
  });


  // Return sorted results (best scores first)
  return Array.from(uniqueResults.values())
    .sort((a, b) => a.score - b.score)
    .map(entry => entry.item);
}
