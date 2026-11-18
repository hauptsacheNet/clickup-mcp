import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ARCHITECTURE_BASELINE } from "../settings.ts";
import { type BaselineEntry, compareBaseline, isScanned, scanFile } from "./index.ts";

try {
  const files = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" }).split("\n").filter(isScanned);
  const found = files.flatMap((path) => scanFile(path, readFileSync(path, "utf8")));
  const baseline: BaselineEntry[] = JSON.parse(readFileSync(ARCHITECTURE_BASELINE, "utf8")).entries;
  const { fresh, stale } = compareBaseline(found, baseline);
  for (const id of fresh) console.log(`NEW ${id}`);
  for (const id of stale) console.log(`STALE ${id} (fixed; remove it from ${ARCHITECTURE_BASELINE})`);
  console.log(`${files.length} files, ${found.length} known or new violations, ${fresh.length} new, ${stale.length} stale`);
  process.exitCode = fresh.length ? 1 : 0;
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 2;
}
