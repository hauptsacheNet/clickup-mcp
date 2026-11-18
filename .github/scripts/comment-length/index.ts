import { CHECKED_SOURCE, HASH_COMMENT_SOURCE, MAX_COMMENT_LINES, isOurPath } from "../settings.ts";

export type Violation = { file: string; line: number; length: number };
type Range = { start: number; end: number; length: number };

export function scansPath(path: string): boolean {
  return (
    isOurPath(path) &&
    CHECKED_SOURCE.test(path) &&
    !path.split("/").some((part) => ["fixtures", "__fixtures__", "node_modules", "dist"].includes(part))
  );
}

export function scanDiff(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let file = "";
  let line = 0;
  // An added `++x;` reads `+++x;` in a hunk, so `+++ ` is a header only before the first hunk.
  let header = false;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) {
      file = "";
      header = true;
    } else if (header && row.startsWith("+++ ")) {
      const path = row.slice(4).replace(/^b\//, "");
      file = scansPath(path) ? path : "";
    } else if (row.startsWith("@@ ")) {
      header = false;
      line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0);
    }
    else if (file && row.startsWith("+")) {
      if (!added.has(file)) added.set(file, new Set());
      added.get(file)!.add(line++);
    } else if (row.startsWith(" ")) line++;
  }
  return added;
}

function ranges(source: string, hashComments: boolean): Range[] {
  const found: Range[] = [];
  let line = 1;
  let quote = "";
  let block: Range | undefined;
  let current: Range | undefined;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "\n") {
      line++;
      continue;
    }
    if (block) {
      if (char === "*" && next === "/") {
        block.end = line;
        block = undefined;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (!hashComments && (char === "'" || char === '"' || char === "`")) {
      quote = char;
      continue;
    }
    // Regex literals are not parsed, so a quote inside one may hide a comment.
    const marker = hashComments
      ? char === "#" && !(i === 0 && next === "!") && source.slice(source.lastIndexOf("\n", i - 1) + 1, i).trim() === ""
      : char === "/" && next === "/";
    if (!hashComments && char === "/" && next === "*") {
      block = { start: line, end: line, length: 0 };
      found.push(block);
      i++;
    } else if (marker) {
      if (current?.end === line - 1) {
        current.end = line;
        current.length++;
      } else {
        current = { start: line, end: line, length: 1 };
        found.push(current);
      }
      const end = source.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
    } else if (char !== " " && char !== "\t") current = undefined;
  }
  for (const range of found) if (range.length === 0) range.length = range.end - range.start + 1;
  return found;
}

export function scanSource(file: string, source: string, added?: Set<number>): Violation[] {
  if (!scansPath(file)) return [];
  return ranges(source, HASH_COMMENT_SOURCE.test(file))
    .filter(
      (range) =>
        range.length > MAX_COMMENT_LINES &&
        (!added || Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i).some((n) => added.has(n)))
    )
    .map((range) => ({ file, line: range.start, length: range.length }));
}
