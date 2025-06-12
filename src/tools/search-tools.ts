import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import {CONFIG} from "../shared/config";
import {isTaskId, getTaskSearchIndex} from "../shared/utils";
import {generateTaskMetadata} from "./task-tools";

const MAX_SEARCH_RESULTS = 50;

export function registerSearchTools(server: McpServer) {
  // Dynamically construct the searchTasks description
  const searchTasksDescriptionBase = [
    "Searches tasks by name, content, assignees, and ID (case insensitive) with fuzzy matching and support for multiple search terms (OR logic).",
    "Can filter by multiple list_ids, space_ids, todo status, or tasks assigned to the current user. If no search terms provided, returns most recently updated tasks.",
    // Placeholder for language-specific guidance
    "You'll get a rough overview of the tasks that match the search terms, sorted by relevance.",
    "Always use getTaskById to get more specific information if a task is relevant.",
  ];

  if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
    searchTasksDescriptionBase.splice(2, 0, `For optimal results, as your ClickUp tasks may be primarily in '${CONFIG.primaryLanguageHint}', consider providing search terms in English and '${CONFIG.primaryLanguageHint}'.`);
  }

  server.tool(
    "searchTasks",
    searchTasksDescriptionBase.join("\n"),
    {
      terms: z
        .array(z.string())
        .optional()
        .describe(
          "Array of search terms (OR logic). Can include task IDs. Optional - if not provided, returns most recent tasks."
        ),
      list_ids: z
        .array(z.string())
        .optional()
        .describe("Filter tasks to specific list IDs"),
      space_ids: z
        .array(z.string())
        .optional()
        .describe("Filter tasks to specific space IDs"),
      todo: z
        .boolean()
        .optional()
        .describe("Filter for open/todo tasks only (exclude done tasks)"),
      assigned_to_me: z
        .boolean()
        .optional()
        .describe("Filter for tasks assigned to the current user"),
    },
    async ({terms, list_ids, space_ids, todo, assigned_to_me}) => {
      // Get current user ID if filtering by assigned_to_me
      let assignees: string[] | undefined;
      if (assigned_to_me) {
        try {
          const userResponse = await fetch("https://api.clickup.com/api/v2/user", {
            headers: { Authorization: CONFIG.apiKey },
          });
          if (userResponse.ok) {
            const userData = await userResponse.json();
            assignees = [userData.user.id];
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: Could not fetch current user information.",
                },
              ],
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Failed to get current user information.",
              },
            ],
          };
        }
      }

      const searchIndex = await getTaskSearchIndex(space_ids, list_ids, assignees);
      if (!searchIndex) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No tasks available or index could not be built.",
            },
          ],
        };
      }

      // Early return for no search terms
      if (!terms || terms.length === 0) {
        let allTasks = (searchIndex as any)._docs || [];
        if (todo) {
          allTasks = allTasks.filter((task: any) => task.status.type !== "done");
        }

        // Sort by updated date (most recent first) and limit
        const resultTasks = allTasks
          .sort((a: any, b: any) => {
            const dateA = parseInt(a.date_updated || "0");
            const dateB = parseInt(b.date_updated || "0");
            return dateB - dateA;
          })
          .slice(0, MAX_SEARCH_RESULTS);

        if (resultTasks.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No tasks found.",
              },
            ],
          };
        }

        return {
          content: await Promise.all(resultTasks.map((task: any) => generateTaskMetadata(task))),
        };
      }

      // Filter valid search terms
      const validTerms = terms.filter(term => term && term.trim().length > 0);
      if (validTerms.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No valid search terms provided.",
            },
          ],
        };
      }

      const uniqueResults = new Map<string, { item: any, score: number }>();

      // Search with each term
      validTerms.forEach(term => {
        const results = searchIndex.search(term.toLowerCase());
        results.forEach(result => {
          if (result.item && typeof result.item.id === 'string') {
            const currentScore = result.score ?? 1;
            const existing = uniqueResults.get(result.item.id);
            if (!existing || currentScore < existing.score) {
              uniqueResults.set(result.item.id, {
                item: result.item,
                score: currentScore
              });
            }
          }
        });
      });

      // Task ID Fallback Logic
      const potentialTaskIds = validTerms.filter(isTaskId);
      const foundTaskIdsByFuse = new Set(Array.from(uniqueResults.keys()).map(id => id.toLowerCase()));

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
              {headers: {Authorization: CONFIG.apiKey}}
            );
            if (response.ok) {
              const task = await response.json();
              if (task && typeof task.id === 'string') {
                const existing = uniqueResults.get(task.id);
                if (!existing || 0 < existing.score) {
                  uniqueResults.set(task.id, {item: task, score: 0});
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

      let resultTasks = Array.from(uniqueResults.values())
        .sort((a, b) => a.score - b.score)
        .map(entry => entry.item);

      if (todo) {
        resultTasks = resultTasks.filter((task: any) => task.status.type !== "done");
      }

      // Apply result limit
      resultTasks = resultTasks.slice(0, MAX_SEARCH_RESULTS);

      if (resultTasks.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No tasks found matching the search criteria.",
            },
          ],
        };
      }

      return {
        content: await Promise.all(resultTasks.map((task: any) => generateTaskMetadata(task))),
      };
    });
}