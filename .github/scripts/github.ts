import { execFileSync } from "node:child_process";
import { LEDGER_FILE } from "./settings.ts";

const GH_MAX_BUFFER = 64 * 1024 * 1024;
export const PAGE_SIZE = 100;

export type PrDetail = { head: string; author: string; body: string; sameRepo: boolean };

export function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER });
}

export const ghJson = <T>(path: string): T => JSON.parse(gh(["api", path])) as T;
export const ghPages = <T>(path: string): T[] => (JSON.parse(gh(["api", "--paginate", "--slurp", path])) as T[][]).flat();

export function repoOf(env: Record<string, string | undefined> = process.env): string {
  const repo = env.GITHUB_REPOSITORY || gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("cannot resolve the repository");
  return repo;
}

export function prDetail(repo: string, pr: number): PrDetail {
  const raw = ghJson<{ head?: { sha?: string; repo?: { full_name?: string } | null }; user?: { login?: string }; body?: string | null }>(`repos/${repo}/pulls/${pr}`);
  if (!raw.head?.sha || !raw.user?.login) throw new Error("cannot read the pull request");
  return { head: raw.head.sha, author: raw.user.login, body: raw.body ?? "", sameRepo: raw.head.repo?.full_name === repo };
}

export const prFiles = (repo: string, pr: number): string[] =>
  ghPages<{ filename: string }>(`repos/${repo}/pulls/${pr}/files?per_page=${PAGE_SIZE}`).map((file) => file.filename);

// Same rule as the kratos workflow: Markdown only, and the upstream patch ledger is not docs.
export const isDocsOnly = (paths: string[]): boolean =>
  paths.length > 0 && paths.every((path) => path.endsWith(".md") && path !== LEDGER_FILE);

export function parsePr(arg: string | undefined): number | null {
  return arg && /^[1-9]\d*$/.test(arg) ? Number(arg) : null;
}
