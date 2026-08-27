import { CONFIG } from "./config";

/** A task comment as returned by GET /api/v2/task/{task_id}/comment or GET /comment/{id}/reply */
export interface ExistingComment {
  id: string;
  date: string;
  comment?: any[];
  comment_text?: string;
  user?: { id?: number | string; username?: string };
  reply_count?: number;
}

/** Cursor into the comment list: the date and id of the last comment of the previous page */
export interface CommentPageCursor {
  start: string;
  startId: string;
}

/**
 * Never page further back than this. A busy ticket would otherwise walk its
 * entire comment history and eat the 100 calls/minute budget.
 */
export const MAX_COMMENT_PAGES = 10;

/** Page size ClickUp uses for the comment list - a shorter page means the last page. */
const COMMENTS_PER_PAGE = 25;

/** One page of task comments, newest first, 25 per page */
export async function fetchCommentPage(
  taskId: string,
  cursor?: CommentPageCursor
): Promise<ExistingComment[]> {
  // Note there is no `start_date` parameter - passing one is silently ignored.
  // Older pages are reached with `start` + `start_id` of the previous page's last entry.
  const query = cursor
    ? `?${new URLSearchParams({ start: cursor.start, start_id: cursor.startId })}`
    : "";

  const response = await fetch(
    `https://api.clickup.com/api/v2/task/${taskId}/comment${query}`,
    { headers: { Authorization: CONFIG.apiKey } }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Error loading comments of task ${taskId}: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`
    );
  }

  const data = await response.json();
  return Array.isArray(data.comments) ? data.comments : [];
}

/**
 * All top-level comments of a task, newest first.
 *
 * The comment list endpoint returns 25 comments per page, so longer histories are
 * paged with `start`/`start_id`. Paging is capped at MAX_COMMENT_PAGES (250 comments)
 * to protect the API budget; hitting the cap is logged instead of failing.
 */
export async function fetchAllTopLevelComments(taskId: string): Promise<ExistingComment[]> {
  const comments: ExistingComment[] = [];
  let cursor: CommentPageCursor | undefined;
  let pages = 0;
  let lastPageWasFull = false;

  while (pages < MAX_COMMENT_PAGES) {
    const page = await fetchCommentPage(taskId, cursor);
    pages++;
    if (page.length === 0) {
      lastPageWasFull = false;
      break;
    }

    comments.push(...page);
    lastPageWasFull = page.length >= COMMENTS_PER_PAGE;
    if (!lastPageWasFull) {
      break;
    }

    const oldest = page[page.length - 1];
    cursor = { start: String(oldest.date), startId: String(oldest.id) };
  }

  if (lastPageWasFull && pages >= MAX_COMMENT_PAGES) {
    console.error(
      `Task ${taskId} has more than ${comments.length} top-level comments - older comments were not loaded (capped at ${MAX_COMMENT_PAGES} pages).`
    );
  }

  return comments;
}

/**
 * Find a top-level comment of a task by id, paging as far as MAX_COMMENT_PAGES.
 *
 * Unlike editComment's lookup this does not stop at the edit window, because a
 * thread parent can be arbitrarily old. Returns undefined when the id is not a
 * top-level comment of this task - which also catches reply ids, since replies
 * never appear in the task's comment list.
 */
export async function findTopLevelComment(
  taskId: string,
  commentId: string
): Promise<ExistingComment | undefined> {
  let cursor: CommentPageCursor | undefined;

  for (let pages = 0; pages < MAX_COMMENT_PAGES; pages++) {
    const page = await fetchCommentPage(taskId, cursor);
    const match = page.find((entry) => String(entry.id) === String(commentId));
    if (match) {
      return match;
    }
    if (page.length < COMMENTS_PER_PAGE) {
      return undefined;
    }
    const oldest = page[page.length - 1];
    cursor = { start: String(oldest.date), startId: String(oldest.id) };
  }

  return undefined;
}

/**
 * The replies inside a comment thread, oldest first.
 *
 * `GET /task/{id}/comment` only returns top-level comments; the replies of a
 * thread (Threaded Comments ClickApp) live behind `GET /comment/{id}/reply`.
 * Any failure (non-ok response, network error, malformed body) is logged and
 * returns an empty array so one broken thread does not take down the whole
 * task view.
 */
export async function fetchCommentReplies(commentId: string): Promise<ExistingComment[]> {
  try {
    const response = await fetch(
      `https://api.clickup.com/api/v2/comment/${commentId}/reply`,
      { headers: { Authorization: CONFIG.apiKey } }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(
        `Error fetching replies for comment ${commentId}: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`
      );
      return [];
    }

    const data = await response.json();
    const replies: ExistingComment[] = Array.isArray(data?.comments) ? data.comments : [];
    return replies.sort((a, b) => Number(a.date) - Number(b.date));
  } catch (error) {
    console.error(`Error fetching replies for comment ${commentId}:`, error);
    return [];
  }
}

/**
 * Never fetch more threads than this per task read, and never more than a few
 * at once - together with MAX_COMMENT_PAGES this keeps a single getTaskById
 * within ClickUp's 100 calls/minute budget even on a heavily threaded task.
 */
export const MAX_REPLY_FETCHES = 30;
const REPLY_FETCH_CONCURRENCY = 5;

/**
 * Fetch the replies of every comment with reply_count > 0, bounded in count and
 * concurrency. Returns a map of comment id -> replies; a thread that was skipped
 * (over the cap) or failed to load is simply absent or empty, so callers can
 * render a "replies not loaded" hint from reply_count.
 */
export async function fetchRepliesByComment(
  comments: ExistingComment[]
): Promise<Map<string, ExistingComment[]>> {
  const threaded = comments.filter((comment) => (comment.reply_count ?? 0) > 0);
  const toFetch = threaded.slice(0, MAX_REPLY_FETCHES);
  if (threaded.length > toFetch.length) {
    console.error(
      `Skipping replies of ${threaded.length - toFetch.length} comment thread(s) - only the ${MAX_REPLY_FETCHES} newest threads are loaded to stay within the API budget.`
    );
  }

  const replies = new Map<string, ExistingComment[]>();
  let next = 0;
  const worker = async () => {
    while (next < toFetch.length) {
      const comment = toFetch[next++];
      replies.set(String(comment.id), await fetchCommentReplies(String(comment.id)));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REPLY_FETCH_CONCURRENCY, toFetch.length) }, worker)
  );

  return replies;
}
