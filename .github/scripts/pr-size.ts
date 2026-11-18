import { execFileSync } from "node:child_process";
import { CODE_LINES_PER_PR_LIMIT, LEDGER_FILE, isOurPath } from "./settings.ts";

export type FileChange = { path: string; additions: number; deletions: number };
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });

export function parseNumstat(text: string): FileChange[] {
  return text.trim().split("\n").filter(Boolean).map((row) => {
    const [added, deleted, path] = row.split("\t");
    return { path: renameTarget(path), additions: Number(added) || 0, deletions: Number(deleted) || 0 };
  });
}

// numstat writes a rename as `src/{a => b}/x.ts` or `old => new`; ownership is decided by the new path.
export function renameTarget(path: string): string {
  if (/\{[^{}]* => [^{}]*\}/.test(path)) return path.replace(/\{[^{}]* => ([^{}]*)\}/, "$1").replace(/\/{2,}/g, "/");
  return path.includes(" => ") ? path.split(" => ")[1] : path;
}

// Paths named in ledger rows that start with `prefix` (`+` reads a diff), of one `kind` when given.
function rowPaths(text: string, prefix: string, kind?: string): Set<string> {
  const rows = text.split("\n").filter((line) => line.startsWith(`${prefix}|`));
  const cells = rows.map((row) => row.slice(prefix.length).split("|").map((cell) => cell.trim()));
  const named = cells.filter((row) => !kind || row[5] === kind).flatMap((row) => [...(row[2] ?? "").matchAll(/`([^`]+)`/g)]);
  return new Set(named.map((match) => match[1].replace(/:[\d,-]+$/, "")));
}

// Only `seam` rows count: a `temporary` row is the author's own PR cherry-picked as written, 0 like a tag bump.
export const seamPaths = (patchDiff: string) => rowPaths(patchDiff, "+", "seam");
export const ledgerPaths = (ledger: string) => rowPaths(ledger, "");
// Each upstream file a PR touches needs a ledger row of any kind.
export const unledgered = (files: FileChange[], ledger: Set<string>) => files.map((f) => f.path).filter((p) => !isOurPath(p) && !ledger.has(p));

export function countCode(files: FileChange[], seams: Set<string>): number {
  return files.reduce((total, file) => {
    if (!isOurPath(file.path) && !seams.has(file.path)) return total;
    if (/\/(?:__tests__|tests|fixtures|__fixtures__)\//.test(file.path) || /\.(?:test|spec)\.[cm]?[jt]s$/.test(file.path))
      return total;
    if (/\.(?:md|json)$/.test(file.path)) return total;
    return total + file.additions + file.deletions;
  }, 0);
}

function main(): void {
  const [flag, range, mode] = process.argv.slice(2);
  if (flag !== "--range" || !range?.includes("...")) throw new Error("usage: bun .github/scripts/pr-size.ts --range <base>...<head> [--ledger]");
  const files = parseNumstat(git("diff", "--numstat", range));
  if (mode === "--ledger") {
    const missing = unledgered(files, ledgerPaths(git("show", `${range.split("...")[1] || "HEAD"}:${LEDGER_FILE}`)));
    missing.forEach((path) => console.log(`no ${LEDGER_FILE} row: ${path}`));
    return void (process.exitCode = missing.length ? 1 : 0);
  }
  const code = countCode(files, seamPaths(git("diff", range, "--", LEDGER_FILE)));
  console.log(`code ${code} / limit ${CODE_LINES_PER_PR_LIMIT}${code > CODE_LINES_PER_PR_LIMIT ? " over" : ""}`);
  if (code > CODE_LINES_PER_PR_LIMIT) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
