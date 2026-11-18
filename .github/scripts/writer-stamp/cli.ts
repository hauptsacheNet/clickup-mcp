import { readFileSync } from "node:fs";
import { isDocsOnly, parsePr, prDetail, prFiles, repoOf } from "../github.ts";
import { stampProblem, stampSummary } from "./index.ts";

const STAMP_HINT = "add a `<!-- writer-stamp v1 provider=… model=… effort=… executor=… profile=… -->` line to the PR body";

// The event payload carries the body as edited, so an edit is judged without waiting on the API.
function eventBody(pr: number): string | null {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const event = JSON.parse(readFileSync(path, "utf8")) as { pull_request?: { number?: number; body?: string | null } };
    return event.pull_request?.number === pr ? event.pull_request.body ?? "" : null;
  } catch { return null; }
}

function main(args: string[]): number {
  const pr = parsePr(args[0]);
  if (!pr || args.length !== 1) {
    console.error("usage: bun .github/scripts/writer-stamp/cli.ts <PR>");
    return 2;
  }
  const repo = repoOf();
  if (isDocsOnly(prFiles(repo, pr))) {
    console.log(`writer-stamp: PR #${pr} is docs-only: skipped`);
    return 0;
  }
  const body = eventBody(pr) ?? prDetail(repo, pr).body;
  const problem = stampProblem(body);
  if (problem) {
    console.error(`writer-stamp: PR #${pr}: ${problem}; ${STAMP_HINT}`);
    return 1;
  }
  console.log(`writer-stamp: green PR #${pr}: ${stampSummary(body)}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`writer-stamp: ${(error as Error).message.split("\n", 1)[0]}`);
    process.exitCode = 1;
  }
}
