import { gh, ghPages, isDocsOnly, PAGE_SIZE, parsePr, prDetail, prFiles, repoOf } from "../github.ts";
import { openFindings, type IssueComment, type Review, type ReviewComment } from "./index.ts";

const CONTEXT = "review-verdicts";
const DESCRIPTION_MAX_CHARS = 140;

export type Verdict = { state: "success" | "failure"; description: string };

export function verdict(open: string[], docsOnly: boolean): Verdict {
  if (docsOnly) return { state: "success", description: "docs-only change: skipped" };
  if (!open.length) return { state: "success", description: "no open findings" };
  return { state: "failure", description: `open findings: ${open.join(", ")}`.slice(0, DESCRIPTION_MAX_CHARS) };
}

function main(args: string[]): number {
  const pr = parsePr(args[0]);
  const dryRun = args[1] === "--dry-run";
  if (!pr || args.length > 2 || (args[1] !== undefined && !dryRun)) {
    console.error("usage: bun .github/scripts/review-verdicts/cli.ts <PR> [--dry-run]");
    return 2;
  }
  const repo = repoOf();
  const before = prDetail(repo, pr);
  const base = `repos/${repo}/pulls/${pr}`;
  const docsOnly = isDocsOnly(prFiles(repo, pr));
  const open = docsOnly ? [] : openFindings({
    author: before.author, head: before.head,
    reviews: ghPages<Review>(`${base}/reviews?per_page=${PAGE_SIZE}`),
    comments: ghPages<ReviewComment>(`${base}/comments?per_page=${PAGE_SIZE}`),
    issueComments: ghPages<IssueComment>(`repos/${repo}/issues/${pr}/comments?per_page=${PAGE_SIZE}`),
  });
  // A push between the reads would put this verdict on a head it never saw.
  if (prDetail(repo, pr).head !== before.head) throw new Error("pull request head moved during the check");
  const result = verdict(open, docsOnly);
  console.log(`${result.state}: ${result.description}`);
  if (!dryRun) {
    gh(["api", "-X", "POST", `repos/${repo}/statuses/${before.head}`, "-f", `state=${result.state}`, "-f", `context=${CONTEXT}`,
      "-f", `description=${result.description}`, ...(process.env.RUN_URL ? ["-f", `target_url=${process.env.RUN_URL}`] : [])]);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`review-verdicts: ${(error as Error).message.split("\n", 1)[0]}`);
    process.exitCode = 1;
  }
}
