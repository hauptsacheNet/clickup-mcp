import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { MAX_COMMENT_LINES } from "../settings.ts";
import { scanDiff, scanSource, scansPath } from "./index.ts";

const range = process.argv[2];
if (!range) {
  console.error("usage: bun .github/scripts/comment-length/cli.ts <base>...<head> | --all");
  process.exit(2);
}
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
try {
  const files: Map<string, Set<number> | undefined> =
    range === "--all"
      ? new Map(git("ls-files").split("\n").filter(scansPath).map((path) => [path, undefined]))
      : scanDiff(git("diff", "--no-color", "--no-ext-diff", "--unified=0", range));
  const head = range.split("...")[1] || "HEAD";
  const violations = [...files].flatMap(([file, added]) =>
    scanSource(file, range === "--all" ? readFileSync(file, "utf8") : git("show", `${head}:${file}`), added)
  );
  for (const v of violations) console.log(`${v.file}:${v.line} comment block of ${v.length} lines (max ${MAX_COMMENT_LINES})`);
  console.log(`${violations.length} violations`);
  process.exitCode = violations.length ? 1 : 0;
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 2;
}
