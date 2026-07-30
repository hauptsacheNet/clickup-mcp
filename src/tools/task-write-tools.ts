import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { getCurrentUser } from "../shared/utils";
import {
  collectMarkdownImageSources,
  convertMarkdownToClickUpBlocks,
  normalizeImageDestinations,
  rewriteMarkdownImageUrls,
} from "../clickup-text";
import {
  ResolvedMarkdownImage,
  UploadedMarkdownImage,
  resolveMarkdownImages,
  toAttachmentMap,
  uploadResolvedImages,
} from "../shared/attachments";

/**
 * Shared wording for the image support of every markdown field in this file.
 * Kept in one place so the tools stay consistent about what a client may pass.
 */
const IMAGE_SUPPORT_HINT = [
  "IMAGES: Reference images with normal markdown - `![caption](/absolute/path/to/screenshot.png)`.",
  "This server runs locally, so a local file path is read and uploaded automatically - never inline a screenshot as base64 when a path exists, it costs orders of magnitude more tokens.",
  "Also accepted: `data:` URIs, http(s) URLs (downloaded and re-uploaded), and existing ClickUp attachment URLs (embedded as-is).",
  "The caption becomes the attachment filename, which is what ClickUp displays beneath the image - so write a caption that reads well.",
].join("\n");

/**
 * Phase 1 of image handling: parse the markdown and resolve every image source
 * (read files, download URLs, decode data URIs) WITHOUT writing anything.
 *
 * Throws when any reference is unusable, listing every broken source at once.
 * Nothing has been posted to ClickUp when this throws, so the caller's generic
 * error path returns the report and the client can fix the markdown and retry.
 */
async function resolveImagesOrAbort(
  markdown: string | undefined,
  abortNotice: string
): Promise<{ markdown: string; images: ResolvedMarkdownImage[] }> {
  if (!markdown) {
    return { markdown: markdown ?? "", images: [] };
  }

  // Normalise first, then use the same string for collecting and converting - the
  // sources must line up with what the converter later looks up.
  const normalized = normalizeImageDestinations(markdown);

  const sources = collectMarkdownImageSources(normalized);
  if (sources.length === 0) {
    return { markdown: normalized, images: [] };
  }

  const { resolved, failures } = await resolveMarkdownImages(sources);
  if (failures.length > 0) {
    throw new Error(
      [
        `${failures.length} image reference(s) could not be used, so ${abortNotice}:`,
        ...failures.map((failure) => `  - ${failure.src}: ${failure.error}`),
        `Fix or remove these image references and retry.`,
      ].join("\n")
    );
  }

  return { markdown: normalized, images: resolved };
}

/**
 * Phase 2: upload the resolved images to the task.
 *
 * Throws on the first upload failure. Everything uploaded before the failure is
 * listed with its CDN URL so a retry can reference those URLs directly (existing
 * ClickUp URLs are embedded without re-uploading).
 */
async function uploadImagesOrAbort(
  taskId: string,
  images: ResolvedMarkdownImage[],
  abortNotice: string
): Promise<UploadedMarkdownImage[]> {
  if (images.length === 0) {
    return [];
  }

  const { uploaded, failure } = await uploadResolvedImages(taskId, images);
  if (failure) {
    const lines = [
      `Uploading image "${failure.src}" failed, so ${abortNotice}:`,
      `  ${failure.error}`,
    ];
    if (uploaded.length > 0) {
      lines.push(
        `${uploaded.length} image(s) were already uploaded to task ${taskId} before the failure - on retry, reference these URLs directly to avoid duplicate uploads:`,
        ...uploaded.map((u) => `  - ${u.attachment.name}: ${u.attachment.url}`)
      );
    }
    throw new Error(lines.join("\n"));
  }

  return uploaded;
}

/**
 * Echo a markdown field back without repeating inline base64 payloads.
 * Without this a single data-URI screenshot would be mirrored back into the
 * response, costing as many tokens again as it did going in.
 */
function summarizeMarkdownForEcho(markdown: string): string {
  return markdown.replace(
    /(!\[[^\]]*\]\()data:([^;,)]+)[^)]*(\))/g,
    (_match, prefix: string, mimeType: string, suffix: string) =>
      `${prefix}[inline ${mimeType} data]${suffix}`
  );
}

/** Report successfully attached images so the caller can verify and link to them */
function formatAttachedImages(uploaded: UploadedMarkdownImage[]): string[] {
  if (uploaded.length === 0) {
    return [];
  }
  return [
    `images_attached: ${uploaded.length}`,
    ...uploaded.map((u) => `  - ${u.attachment.name} (${u.attachment.url})`),
  ];
}

// Shared schemas for task parameters
const taskNameSchema = z.string().min(1).describe("The name/title of the task");
const taskPrioritySchema = z.enum(["urgent", "high", "normal", "low"]).optional().describe("Optional priority level");
const taskDueDateSchema = z.string().optional().describe("Optional due date as ISO date string (e.g., '2024-10-06T23:59:59+02:00')");
const taskStartDateSchema = z.string().optional().describe("Optional start date as ISO date string (e.g., '2024-10-06T09:00:00+02:00')");
const taskTimeEstimateSchema = z.number().optional().describe("Optional time estimate in hours (will be converted to milliseconds)");
const taskTagsSchema = z.array(z.string()).optional().describe("Optional array of tag names");

export function registerTaskToolsWrite(server: McpServer, userData: any) {
  server.tool(
    "addComment",
    (() => {
      const descriptionBase = [
        "Adds a comment to a specific task.",
        "LINKING BEST PRACTICES:",
        "- Always reference related tasks using ClickUp URLs (https://app.clickup.com/t/TASK_ID)",
        "- Include task links when mentioning dependencies, related work, or follow-ups",
        "- Link to relevant lists, spaces, or other ClickUp entities when applicable",
        "PROGRESS UPDATES: Include current status, progress information, and next steps.",
        IMAGE_SUPPORT_HINT,
        "IMAGE LAYOUT: An image inside a numbered list breaks ClickUp's numbering. Write walkthrough steps as bold lines with a blank line before and after the image instead (`**1. Open the login page**`).",
        "If external links are provided, verify they are publicly accessible and incorporate relevant information.",
        "Check the task's current status - if it's in 'backlog' or similar inactive states, suggest moving it to an active status like 'in progress' when work is being done."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing comments in '${CONFIG.primaryLanguageHint}' unless the task is already in another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to comment on"),
      comment: z.string().min(1).describe("The comment text to add to the task"),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async ({ task_id, comment }) => {
      try {
        // Resolve and upload referenced images first - the fragments need the
        // attachment objects from the upload response, a bare URL renders as an
        // empty tile. Any image problem aborts BEFORE the comment is posted, so
        // the caller can fix the markdown and retry without creating duplicates.
        const abortNotice = "the comment was NOT posted";
        const { markdown, images } = await resolveImagesOrAbort(comment, abortNotice);
        const uploaded = await uploadImagesOrAbort(task_id, images, abortNotice);

        // Convert markdown to ClickUp formatted blocks
        const commentBlocks = convertMarkdownToClickUpBlocks(markdown, toAttachmentMap(uploaded));

        const requestBody = {
          comment: commentBlocks,
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
                `comment: ${summarizeMarkdownForEcho(comment)}`,
                `date: ${timestampToIso(commentData.date || Date.now())}`,
                `user: ${commentData.user?.username || 'Current user'}`,
                ...formatAttachedImages(uploaded),
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
    "updateTask",
    (() => {
      const descriptionBase = [
        "Updates various aspects of an existing task including dependencies and relationships.",
        "ALWAYS include the task URL (https://app.clickup.com/t/TASK_ID) when updating or referencing tasks.",
        "Use getListInfo first to see valid status options.",
        "SAFETY FEATURE: Description updates are APPEND-ONLY to prevent data loss - existing content is preserved.",
        "STATUS UPDATES: Use the `addComment` tool for progress reports, work logs, and status updates rather than the task description.",
        IMAGE_SUPPORT_HINT,
        "Task descriptions should contain requirements, specifications, and core task information.",
        "LINKING IN DESCRIPTIONS: When appending descriptions, include links to related tasks, lists, or external resources.",
        "IMPORTANT: When updating tasks (especially when booking time or adding progress), ensure the status makes sense for the work being done - tasks in 'backlog' or 'closed' states usually shouldn't have active work.",
        "Suggest appropriate status transitions and always provide the clickable task URL in responses."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing task names and descriptions in '${CONFIG.primaryLanguageHint}' unless the task is already in another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      task_id: z.string().min(6).max(9).describe("The 6-9 character task ID to update"),
      name: taskNameSchema.optional(),
      append_description: z.string().optional().describe("Optional markdown content to APPEND to existing task description (preserves existing content for safety)"),
      status: z.string().optional().describe("Optional new status name - use getListInfo to see valid options"),
      priority: taskPrioritySchema,
      due_date: taskDueDateSchema,
      start_date: taskStartDateSchema,
      time_estimate: taskTimeEstimateSchema,
      tags: taskTagsSchema.describe("Optional array of tag names (will replace existing tags)"),
      parent_task_id: z.string().optional().describe("Optional parent task ID to change parent/child relationships"),
      assignees: z.array(z.string()).optional().describe(createAssigneeDescription(userData)),
      waiting_on: z.array(z.string()).optional().describe("Optional array of task IDs that this task should wait on (will replace existing waiting_on relationships)"),
      blocking: z.array(z.string()).optional().describe("Optional array of task IDs that this task should block. Note: This creates dependencies FROM those tasks TO this task (those tasks will wait on this one)"),
      linked_tasks: z.array(z.string()).optional().describe("Optional array of task IDs to link as related tasks without blocking (will replace existing linked tasks)")
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ task_id, name, append_description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees, blocking, waiting_on, linked_tasks }) => {
      try {
        const userData = await getCurrentUser();

        // Get task details including current markdown description
        const taskResponse = await fetch(`https://api.clickup.com/api/v2/task/${task_id}?include_markdown_description=true`, {
          headers: { Authorization: CONFIG.apiKey },
        });

        if (!taskResponse.ok) {
          throw new Error(`Error fetching task: ${taskResponse.status} ${taskResponse.statusText}`);
        }

        const taskData = await taskResponse.json();

        // Resolve and upload description images FIRST - an image problem must
        // abort before dependencies, tags or the task itself are touched, so the
        // caller can fix the markdown and retry the whole call cleanly.
        let appendedDescription: string | undefined;
        let uploadedImages: UploadedMarkdownImage[] = [];
        if (append_description) {
          const abortNotice = "the task was NOT updated";
          const prepared = await resolveImagesOrAbort(append_description, abortNotice);
          uploadedImages = await uploadImagesOrAbort(task_id, prepared.images, abortNotice);
          // Descriptions render plain markdown, so no image fragments are involved
          // here - the local paths are simply swapped for the CDN URLs.
          appendedDescription = rewriteMarkdownImageUrls(
            prepared.markdown,
            toAttachmentMap(uploadedImages)
          );
        }

        // Handle dependencies separately since they need individual API calls
        let dependencyUpdateResults: string[] = [];
        if (blocking !== undefined || waiting_on !== undefined || linked_tasks !== undefined) {
          const dependencyResults = await updateTaskDependencies(
            task_id,
            taskData,
            { blocking, waiting_on, linked_tasks }
          );
          dependencyUpdateResults = dependencyResults;
        }

        // Handle tags separately since they need individual API calls
        let tagUpdateResults: string[] = [];
        if (tags !== undefined) {
          // Get current tags
          const currentTags = taskData.tags?.map((t: any) => t.name) || [];
          const tagsToAdd = tags.filter(tag => !currentTags.includes(tag));
          const tagsToRemove = currentTags.filter((tag: string) => !tags.includes(tag));

          // Add new tags
          for (const tagName of tagsToAdd) {
            try {
              const addTagResponse = await fetch(
                `https://api.clickup.com/api/v2/task/${task_id}/tag/${encodeURIComponent(tagName)}`,
                {
                  method: 'POST',
                  headers: { Authorization: CONFIG.apiKey }
                }
              );
              if (!addTagResponse.ok) {
                console.error(`Failed to add tag "${tagName}": ${addTagResponse.status}`);
                tagUpdateResults.push(`Failed to add tag: ${tagName}`);
              }
            } catch (error) {
              console.error(`Error adding tag "${tagName}":`, error);
              tagUpdateResults.push(`Error adding tag: ${tagName}`);
            }
          }

          // Remove old tags
          for (const tagName of tagsToRemove) {
            try {
              const removeTagResponse = await fetch(
                `https://api.clickup.com/api/v2/task/${task_id}/tag/${encodeURIComponent(tagName)}`,
                {
                  method: 'DELETE',
                  headers: { Authorization: CONFIG.apiKey }
                }
              );
              if (!removeTagResponse.ok) {
                console.error(`Failed to remove tag "${tagName}": ${removeTagResponse.status}`);
                tagUpdateResults.push(`Failed to remove tag: ${tagName}`);
              }
            } catch (error) {
              console.error(`Error removing tag "${tagName}":`, error);
              tagUpdateResults.push(`Error removing tag: ${tagName}`);
            }
          }
        }

        // Handle append-only description update with markdown support
        let finalDescription: string | undefined;
        if (appendedDescription !== undefined) {
          const currentDescription = taskData.markdown_description || "";
          const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
          const separator = currentDescription.trim() ? "\n\n---\n" : "";
          finalDescription = currentDescription + separator + `**Edit (${timestamp}):** ${appendedDescription}`;
        }

        // Build update body without tags (they're handled separately)
        const updateBody = buildTaskRequestBody({
          name, status, priority, due_date, start_date, time_estimate, parent_task_id, assignees
        });

        // Add markdown description if we have content to append
        if (finalDescription !== undefined) {
          updateBody.markdown_description = finalDescription;
        }

        // Handle assignees for updates (different from creates)
        if (assignees !== undefined) {
          updateBody.assignees = { add: assignees, rem: [] }; // Add new assignees, remove none
        }

        // Check if there's anything to update (including tags and dependencies which were handled separately)
        if (Object.keys(updateBody).length === 0 && tags === undefined && blocking === undefined && waiting_on === undefined && linked_tasks === undefined) {
          return {
            content: [
              {
                type: "text",
                text: "No updates provided. Please specify at least one field to update.",
              },
            ],
          };
        }

        // Update the task (if there are non-tag updates)
        let updatedTask = taskData;
        if (Object.keys(updateBody).length > 0) {
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
            throw new Error(`Error updating task: ${updateResponse.status} ${updateResponse.statusText} - ${JSON.stringify(errorData)}`);
          }

          updatedTask = await updateResponse.json();
        }

        // If only tags or dependencies were updated, fetch the task again to get the updated state
        if ((tags !== undefined || blocking !== undefined || waiting_on !== undefined || linked_tasks !== undefined) && Object.keys(updateBody).length === 0) {
          const refreshResponse = await fetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
            headers: { Authorization: CONFIG.apiKey },
          });
          if (refreshResponse.ok) {
            updatedTask = await refreshResponse.json();
          }
        }

        const responseLines = formatTaskResponse(updatedTask, 'updated', {
          name, append_description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees, blocking, waiting_on, linked_tasks
        }, userData);

        // Add dependency update results if any
        if (dependencyUpdateResults.length > 0) {
          responseLines.push('dependency_warnings: ' + dependencyUpdateResults.join('; '));
        }

        // Add tag update results if any
        if (tagUpdateResults.length > 0) {
          responseLines.push('tag_warnings: ' + tagUpdateResults.join('; '));
        }

        responseLines.push(...formatAttachedImages(uploadedImages));

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error updating task:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating task: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "createTask",
    (() => {
      const descriptionBase = [
        "Creates a new task in a specific list and assigns it to specified users (defaults to current user).",
        "CRITICAL LINKING REQUIREMENTS:",
        "- ALWAYS search for similar existing tasks first using searchTasks to avoid duplicates",
        "- Include links to related tasks in the description (format: https://app.clickup.com/t/TASK_ID)",
        "- Reference parent/child tasks, dependencies, and related work with clickable links",
        "- The response will include the new task's clickable URL - always share this link",
        "Use getListInfo first to understand the list context and available statuses.",
        "Task descriptions support full markdown formatting including **bold**, *italic*, lists, links, and code blocks.",
        IMAGE_SUPPORT_HINT,
        "BEST PRACTICE: Every task creation should result in sharing the clickable task URL for future reference."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing task names and descriptions in '${CONFIG.primaryLanguageHint}' unless specified otherwise or unless the context requires another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      list_id: z.string().min(1).describe("The ID of the list where the task will be created. Note: ClickUp API does not support moving tasks between lists after creation - this must be done manually in the ClickUp interface"),
      name: taskNameSchema,
      description: z.string().optional().describe("Optional markdown description for the task - supports full markdown formatting"),
      status: z.string().optional().describe("Optional status name - use getListInfo to see valid options"),
      priority: taskPrioritySchema,
      due_date: taskDueDateSchema,
      start_date: taskStartDateSchema,
      time_estimate: taskTimeEstimateSchema,
      tags: taskTagsSchema,
      parent_task_id: z.string().optional().describe("Optional parent task ID to create this as a subtask"),
      assignees: z.array(z.string()).optional().describe(createAssigneeDescription(userData))
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ list_id, name, description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees }) => {
      try {
        // Resolve description images BEFORE creating the task: a broken reference
        // (missing file, dead URL, non-image) must not leave a half-finished task
        // behind. Uploading has to wait until the task exists, though - ClickUp
        // attachments always belong to a task.
        const { markdown: normalizedDescription, images } = await resolveImagesOrAbort(
          description,
          "the task was NOT created"
        );

        const userData = await getCurrentUser();
        const currentUserId = userData.user.id;

        const requestBody = buildTaskRequestBody({
          name, status, priority, due_date, start_date, time_estimate, tags, assignees, parent_task_id
        }, currentUserId);

        // Add markdown description if provided
        if (description) {
          requestBody.markdown_description = description;
        }

        const response = await fetch(`https://api.clickup.com/api/v2/list/${list_id}/task`, {
          method: 'POST',
          headers: {
            Authorization: CONFIG.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Error creating task: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const createdTask = await response.json();

        // Images can only be attached once the task exists, so the description is
        // written first with its original sources and then rewritten to the CDN URLs.
        // At this point every source resolved successfully - only the upload API
        // itself can still fail, and then the task already exists, so that is
        // reported as a warning instead of pretending the task was not created.
        const imageWarnings: string[] = [];
        const { uploaded, failure: uploadFailure } = await uploadResolvedImages(createdTask.id, images);
        if (uploadFailure) {
          console.error(`Failed to attach image "${uploadFailure.src}": ${uploadFailure.error}`);
          imageWarnings.push(
            `WARNING: the task was created, but uploading image "${uploadFailure.src}" failed: ${uploadFailure.error}`,
            `The description still references the original image source. Fix the problem and add the image via updateTask.`
          );
        }
        const attachmentMap = toAttachmentMap(uploaded);
        if (description && attachmentMap.size > 0) {
          const rewritten = rewriteMarkdownImageUrls(normalizedDescription, attachmentMap);
          if (rewritten !== description) {
            const descriptionResponse = await fetch(`https://api.clickup.com/api/v2/task/${createdTask.id}`, {
              method: 'PUT',
              headers: {
                Authorization: CONFIG.apiKey,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ markdown_description: rewritten })
            });
            if (!descriptionResponse.ok) {
              // The task itself exists - report the problem instead of failing the call.
              console.error(`Failed to write image URLs into description: ${descriptionResponse.status}`);
              imageWarnings.push(
                `WARNING: description update failed (${descriptionResponse.status} ${descriptionResponse.statusText}) - the images are attached to the task but not embedded in the description`
              );
            }
          }
        }

        const responseLines = formatTaskResponse(createdTask, 'created', {
          list_id, name, description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees
        }, userData);

        responseLines.push(...formatAttachedImages(uploaded));
        responseLines.push(...imageWarnings);

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error creating task:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error creating task: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

// Write-specific utility functions

function createAssigneeDescription(userData: any): string {
  const user = userData.user;
  return `Optional array of user IDs to assign to the task (defaults to current user: ${user.username} (${user.id}))`;
}

function convertPriorityToNumber(priority: string): number {
  switch (priority) {
    case "urgent": return 1;
    case "high": return 2;
    case "normal": return 3;
    case "low": return 4;
    default: return 3;
  }
}

function convertPriorityToString(priority: number): string {
  const priorityMap = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
  return priorityMap[priority as keyof typeof priorityMap] || 'unknown';
}

function formatTimeEstimate(hours: number): string {
  const displayHours = Math.floor(hours);
  const displayMinutes = Math.round((hours - displayHours) * 60);
  return displayHours > 0 ? `${displayHours}h ${displayMinutes}m` : `${displayMinutes}m`;
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

function buildTaskRequestBody(params: {
  name?: string;
  description?: string;
  status?: string;
  priority?: string;
  due_date?: string;
  start_date?: string;
  time_estimate?: number;
  tags?: string[];
  assignees?: string[];
  parent_task_id?: string;
}, currentUserId?: string): any {
  const requestBody: any = {};

  if (params.name !== undefined) {
    requestBody.name = params.name;
  }

  if (params.status !== undefined) {
    requestBody.status = params.status;
  }

  if (params.priority !== undefined) {
    requestBody.priority = convertPriorityToNumber(params.priority);
  }

  if (params.due_date !== undefined) {
    requestBody.due_date = new Date(params.due_date).getTime();
  }

  if (params.start_date !== undefined) {
    requestBody.start_date = new Date(params.start_date).getTime();
  }

  if (params.time_estimate !== undefined) {
    requestBody.time_estimate = Math.round(params.time_estimate * 60 * 60 * 1000);
  }

  // Tags are handled separately via dedicated API endpoints
  // Do not include in the update request body

  if (params.assignees !== undefined) {
    requestBody.assignees = params.assignees;
  } else if (currentUserId) {
    requestBody.assignees = [currentUserId];
  }

  if (params.parent_task_id !== undefined) {
    requestBody.parent = params.parent_task_id;
  }

  return requestBody;
}

// Helper function to manage task dependencies
async function updateTaskDependencies(
  taskId: string,
  taskData: any,
  dependencies: {
    blocking?: string[];
    waiting_on?: string[];
    linked_tasks?: string[];
  }
): Promise<string[]> {
  const errors: string[] = [];
  
  // Get current dependencies
  const currentBlocking = taskData.blocking?.map((dep: any) => dep.id) || [];
  const currentWaitingOn = taskData.waiting_on?.map((dep: any) => dep.id) || [];
  const currentLinked = taskData.linked_tasks?.map((task: any) => task.id) || [];

  // Helper function to make dependency API calls
  async function modifyDependency(
    operation: 'add' | 'remove',
    type: 'blocking' | 'waiting_on' | 'linked',
    fromTaskId: string,
    toTaskId: string,
    dependsOn: string
  ): Promise<void> {
    try {
      let url: string;
      let options: RequestInit;

      if (type === 'linked') {
        // Linked tasks use a different endpoint
        url = `https://api.clickup.com/api/v2/task/${fromTaskId}/link/${toTaskId}`;
        options = {
          method: operation === 'add' ? 'POST' : 'DELETE',
          headers: { Authorization: CONFIG.apiKey }
        };
      } else {
        // Dependencies (blocking/waiting_on)
        if (operation === 'add') {
          url = `https://api.clickup.com/api/v2/task/${fromTaskId}/dependency`;
          options = {
            method: 'POST',
            headers: {
              Authorization: CONFIG.apiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              depends_on: dependsOn,
              dependency_type: 1 // Always use 1 for waiting_on type
            })
          };
        } else {
          // Remove dependency
          url = `https://api.clickup.com/api/v2/task/${fromTaskId}/dependency?depends_on=${dependsOn}`;
          options = {
            method: 'DELETE',
            headers: { Authorization: CONFIG.apiKey }
          };
        }
      }

      const response = await fetch(url, options);
      if (!response.ok) {
        const action = operation === 'add' ? 'add' : 'remove';
        const typeLabel = type === 'linked' ? 'link' : type.replace('_', ' ');
        console.error(`Failed to ${action} ${typeLabel} "${toTaskId}": ${response.status}`);
        errors.push(`Failed to ${action} ${typeLabel}: ${toTaskId}`);
      }
    } catch (error) {
      const action = operation === 'add' ? 'adding' : 'removing';
      const typeLabel = type === 'linked' ? 'link' : type.replace('_', ' ');
      console.error(`Error ${action} ${typeLabel} "${toTaskId}":`, error);
      errors.push(`Error ${action} ${typeLabel}: ${toTaskId}`);
    }
  }

  // Process blocking dependencies (tasks that should depend on this task)
  if (dependencies.blocking !== undefined) {
    const toAdd = dependencies.blocking.filter(id => !currentBlocking.includes(id));
    const toRemove = currentBlocking.filter((id: string) => !dependencies.blocking!.includes(id));

    // To make another task depend on this one, add dependency FROM that task TO this task
    for (const depTaskId of toAdd) {
      await modifyDependency('add', 'blocking', depTaskId, depTaskId, taskId);
    }
    for (const depTaskId of toRemove) {
      await modifyDependency('remove', 'blocking', depTaskId, depTaskId, taskId);
    }
  }

  // Process waiting_on dependencies
  if (dependencies.waiting_on !== undefined) {
    const toAdd = dependencies.waiting_on.filter(id => !currentWaitingOn.includes(id));
    const toRemove = currentWaitingOn.filter((id: string) => !dependencies.waiting_on!.includes(id));

    for (const depTaskId of toAdd) {
      await modifyDependency('add', 'waiting_on', taskId, depTaskId, depTaskId);
    }
    for (const depTaskId of toRemove) {
      await modifyDependency('remove', 'waiting_on', taskId, depTaskId, depTaskId);
    }
  }

  // Process linked tasks
  if (dependencies.linked_tasks !== undefined) {
    const toAdd = dependencies.linked_tasks.filter(id => !currentLinked.includes(id));
    const toRemove = currentLinked.filter((id: string) => !dependencies.linked_tasks!.includes(id));

    for (const linkedTaskId of toAdd) {
      await modifyDependency('add', 'linked', taskId, linkedTaskId, linkedTaskId);
    }
    for (const linkedTaskId of toRemove) {
      await modifyDependency('remove', 'linked', taskId, linkedTaskId, linkedTaskId);
    }
  }

  return errors;
}

function formatTaskResponse(task: any, operation: 'created' | 'updated', params: any, userData: any): string[] {
  const responseLines = [
    `Task ${operation} successfully!`,
    `task_id: ${task.id}`,
    `name: ${task.name}`,
    ...(operation === 'created' ? [`url: ${task.url}`] : []),
    `status: ${task.status?.status || 'Unknown'}`,
    `assignees: ${task.assignees?.map((a: any) => `${a.username} (${a.id})`).join(', ') || 'None'}`,
    ...(operation === 'created' && params.list_id ? [`list_id: ${params.list_id}`] : []),
    ...(operation === 'updated' ? [
      `updated_by: ${userData.user.username} (${userData.user.id})`,
      `updated_at: ${timestampToIso(Date.now())}`
    ] : [])
  ];

  if (params.priority !== undefined || task.priority) {
    const priority = task.priority ? convertPriorityToString(task.priority.priority) :
                    params.priority ? params.priority : 'unknown';
    responseLines.push(`priority: ${priority}`);
  }

  if (params.due_date !== undefined) {
    responseLines.push(`due_date: ${params.due_date}`);
  }

  if (params.start_date !== undefined) {
    responseLines.push(`start_date: ${params.start_date}`);
  }

  if (params.time_estimate !== undefined) {
    responseLines.push(`time_estimate: ${formatTimeEstimate(params.time_estimate)}`);
  }

  if (params.tags !== undefined && params.tags.length > 0) {
    responseLines.push(`tags: ${params.tags.join(', ')}`);
  }

  if (params.parent_task_id !== undefined) {
    responseLines.push(`parent_task_id: ${params.parent_task_id}`);
  }

  if (params.blocking !== undefined && params.blocking.length > 0) {
    responseLines.push(`blocking: ${params.blocking.join(', ')}`);
  }

  if (params.waiting_on !== undefined && params.waiting_on.length > 0) {
    responseLines.push(`waiting_on: ${params.waiting_on.join(', ')}`);
  }

  if (params.linked_tasks !== undefined && params.linked_tasks.length > 0) {
    responseLines.push(`linked_tasks: ${params.linked_tasks.join(', ')}`);
  }

  return responseLines;
}
