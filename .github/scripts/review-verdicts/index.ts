export const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
export const COPILOT_LOGINS: readonly string[] = ["Copilot", "copilot-pull-request-reviewer[bot]"];
export const DEEPSEEK_MARKER = "<!-- deepseek-review head=";
export const SUMMARY_MARKER = "<!-- review-verdicts -->";
export const FINAL_REVIEW_PREFIX = "<!-- final-review head=";
export const FINAL_REVIEW_DATA_OPEN = "<!-- final-review-data";
export const FINAL_REVIEW_DATA_CLOSE = "-->";
const DEEPSEEK_SECTION = "Findings outside the diff lines:";
const DEEPSEEK_NOT_SENT = "Not sent to DeepSeek — ";
const DEEPSEEK_FINDING = /^- `(.+?):(\d+|\?)`\s+—\s+(.+)$/;
const FIXED_REPLY = /^fixed in\s+(?:[0-9a-f]{7,40}\b|\[[0-9a-f]{7,40}\]\(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/[0-9a-f]{40}\))/;
const DECLINED_REPLY = /^declined:\s*\S/;

export type User = { login?: string };
export type Review = { id: number; user?: User | null; body?: string | null };
export type ReviewComment = { id: number; pull_request_review_id?: number | null; in_reply_to_id?: number | null; user?: User | null; body?: string | null };
export type IssueComment = { user?: User | null; body?: string | null };
export type PrData = { author: string; head: string; reviews: Review[]; comments: ReviewComment[]; issueComments: IssueComment[] };

export const isAnswer = (text: string): boolean => FIXED_REPLY.test(text.trimStart()) || DECLINED_REPLY.test(text.trimStart());

export function reviewerOf(review: Review): "codex" | "copilot" | "deepseek" | null {
  if (review.body?.startsWith(DEEPSEEK_MARKER)) return "deepseek";
  if (review.user?.login === CODEX_LOGIN) return "codex";
  if (COPILOT_LOGINS.includes(review.user?.login ?? "")) return "copilot";
  return null;
}

// Answers the author posted as one issue comment, one `<id>: fixed in …` or `<id>: declined: …` line each.
export function summaryAnswers(comments: IssueComment[], author: string): Set<string> {
  const answered = new Set<string>();
  for (const comment of comments) {
    const lines = (comment.body ?? "").split(/\r?\n/);
    if (comment.user?.login !== author || !lines[0]?.startsWith(SUMMARY_MARKER)) continue;
    for (const line of lines.slice(1)) {
      const id = line.split(/[ :]/, 1)[0];
      const at = Math.max(line.lastIndexOf(": fixed in "), line.lastIndexOf(": declined: "));
      if (id && at >= 0 && isAnswer(line.slice(at + 2))) answered.add(id);
    }
  }
  return answered;
}

// Inline findings by Codex or Copilot, and DeepSeek findings listed in its review body, with whether the author answered.
export function botFindings(data: PrData): { id: string; answered: boolean }[] {
  const byReview = new Map(data.reviews.map((review) => [review.id, review]));
  const replied = new Set<number>();
  for (const comment of data.comments) {
    if (comment.in_reply_to_id != null && comment.user?.login === data.author && isAnswer(comment.body ?? "")) replied.add(comment.in_reply_to_id);
  }
  const findings: { id: string; answered: boolean }[] = [];
  for (const comment of data.comments) {
    if (comment.in_reply_to_id != null) continue;
    const review = byReview.get(comment.pull_request_review_id ?? 0);
    const reviewer = review && reviewerOf(review);
    if (!reviewer || (comment.user?.login !== review.user?.login && reviewerOf({ id: 0, user: comment.user }) !== reviewer)) continue;
    findings.push({ id: `c${comment.id}`, answered: replied.has(comment.id) });
  }
  for (const review of data.reviews) {
    if (reviewerOf(review) !== "deepseek") continue;
    const lines = (review.body ?? "").split(/\r?\n/);
    const start = lines.indexOf(DEEPSEEK_SECTION);
    if (start < 0) continue;
    let n = 0;
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith(DEEPSEEK_NOT_SENT)) break;
      if (DEEPSEEK_FINDING.test(line)) findings.push({ id: `r${review.id}-${++n}`, answered: false });
    }
  }
  return findings;
}

// Open ids from the author's newest final review of this head; a P3 note counts as answered.
export function finalReviewOpen(comments: IssueComment[], author: string, head: string): string[] {
  const marker = `${FINAL_REVIEW_PREFIX}${head} `;
  const latest = comments.filter((comment) => comment.user?.login === author && (comment.body ?? "").split(/\r?\n/, 1)[0]?.startsWith(marker)).at(-1);
  if (!latest) return [];
  const lines = (latest.body ?? "").trim().split(/\r?\n/).slice(1);
  const end = lines.indexOf(FINAL_REVIEW_DATA_CLOSE, 1);
  // A marked review with a broken data block must not clear the gate.
  if (lines[0] !== FINAL_REVIEW_DATA_OPEN || end < 0) return ["final-review-malformed"];
  const data = lines.slice(1, end);
  // The recorder writes these lines to block the merge even when no row is open.
  if (data.some((line) => line.startsWith("ESCALATED"))) return ["final-review-escalated"];
  if (data.some((line) => line.startsWith("APPROACH-WRONG:"))) return ["final-review-approach-wrong"];
  return data
    .filter((line) => line.endsWith(": open") || (line.endsWith(": noted") && !/^[^\s:]+ \[P3\] /.test(line)))
    .map((line) => line.split(/[ :]/, 1)[0]!)
    .filter(Boolean);
}

export function openFindings(data: PrData): string[] {
  const answered = summaryAnswers(data.issueComments, data.author);
  const open = [
    ...botFindings(data).filter((finding) => !finding.answered).map((finding) => finding.id),
    ...finalReviewOpen(data.issueComments, data.author, data.head),
  ];
  return [...new Set(open.filter((id) => !answered.has(id)))];
}
