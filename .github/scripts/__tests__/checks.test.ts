import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isOurPath } from "../settings.ts";
import { scanDiff, scanSource } from "../comment-length/index.ts";
import { checkFile } from "../file-size.ts";
import { countCode, ledgerPaths, parseNumstat, seamPaths, unledgered } from "../pr-size.ts";
import { expectedFailures, failedTitles, matchesTestGlob, unexpectedFailures } from "../upstream-tests.ts";

describe("isOurPath", () => {
  test.each([
    ["src/kratos/a.ts", true],
    ["src/kratos/tests/list-by-status.test.ts", true],
    [".github/scripts/settings.ts", true],
    [".github/workflows/kratos.yml", true],
    [".github/workflows/test.yml", false],
    [".github/workflows/release.yml", false],
    ["docs/dev/playbook.md", true],
    ["UPSTREAM-PATCHES.md", true],
    ["src/tools/task-tools.ts", false],
    ["src/kratosx/a.ts", false],
    ["package.json", false],
  ])("%s → %p", (path, ours) => expect(isOurPath(path)).toBe(ours));
});

describe("upstream test files", () => {
  test.each([
    ["src/tests/addComment.test.ts", true],
    ["src/tools/x.test.ts", true],
    ["src/tests/setup.ts", false],
    ["src/kratos/a.test.ts", false],
    ["src/kratos/tests/a.test.ts", false],
    ["src/a.test.ts", false],
  ])("%s → %p", (path, matched) => expect(matchesTestGlob(path)).toBe(matched));
});

describe("PR size", () => {
  const files = [
    { path: "src/kratos/list-by-status.ts", additions: 4, deletions: 0 },
    { path: "src/index.ts", additions: 2, deletions: 1 },
    { path: "src/tools/task-tools.ts", additions: 50, deletions: 10 },
    { path: "src/kratos/tests/list-by-status.test.ts", additions: 5, deletions: 0 },
    { path: "docs/dev/playbook.md", additions: 30, deletions: 0 },
    { path: "UPSTREAM.json", additions: 5, deletions: 0 },
  ];
  test("counts only ours without a ledger row", () => expect(countCode(files, new Set())).toBe(4));
  test("an added seam row counts its upstream files", () => {
    const ledger = "+| P3 | `src/index.ts:12`, `src/index.ts:40-41` | register | contract | seam | None |";
    expect(countCode(files, seamPaths(ledger))).toBe(7);
  });
  test("a temporary row counts 0", () => {
    const ledger = "+| P1 | `src/tools/task-tools.ts` | cherry-pick | author's PR | temporary | None |";
    expect(countCode(files, seamPaths(ledger))).toBe(4);
  });
  test("a removed seam row does not count", () => {
    const ledger = "-| P3 | `src/index.ts:12` | register | contract | seam | None |";
    expect(countCode(files, seamPaths(ledger))).toBe(4);
  });
  test("a rename into our directory counts by its new path", () => {
    const renamed = parseNumstat("3\t1\tsrc/{tools => kratos}/a.ts\n2\t0\told.ts => src/kratos/b.ts\n");
    expect(renamed.map((file) => file.path)).toEqual(["src/kratos/a.ts", "src/kratos/b.ts"]);
    expect(countCode(renamed, new Set())).toBe(6);
  });
  test("an upstream file without a ledger row is reported", () => {
    const p1 = "| P1 | `src/tools/task-tools.ts` | cherry-pick | author's PR | temporary | None |\n";
    const p3 = "| P3 | `src/index.ts:12` | register | contract | seam | None |\n";
    expect(unledgered(files, ledgerPaths(`# Ledger\n${p1}${p3}`))).toEqual([]);
    expect(unledgered(files, ledgerPaths(p3))).toEqual(["src/tools/task-tools.ts"]);
    expect(ledgerPaths(readFileSync("UPSTREAM-PATCHES.md", "utf8")).has("src/tools/task-tools.ts")).toBe(true);
    expect(unledgered(files, new Set())).toEqual(["src/index.ts", "src/tools/task-tools.ts"]);
  });
});

describe("expected upstream failures", () => {
  const head = "# Upstream patches\n\n## Patches\n\n| `src/tests/x.test.ts` | not a failure row | x |\n\n";
  test("an empty list expects nothing", () => {
    const expected = expectedFailures(`${head}## Expected upstream failures\n\nNone.\n`);
    expect(expected.size).toBe(0);
    const actual = failedTitles("not ok 1 - posts a comment\n", "src/tests/addComment.test.ts");
    expect(unexpectedFailures(actual, expected)).toEqual([{ file: "src/tests/addComment.test.ts", title: "posts a comment" }]);
  });
  test("one row accepts its failure and rejects another", () => {
    const ledger = `${head}## Expected upstream failures\n\n| Test file | Test title | Failure |\n|---|---|---|\n| \`src/tests/addComment.test.ts\` | posts a comment | timeout |\n`;
    const expected = expectedFailures(ledger);
    expect([...expected]).toEqual(["src/tests/addComment.test.ts|posts a comment"]);
    const file = "src/tests/addComment.test.ts";
    expect(unexpectedFailures([{ file, title: "posts a comment" }], expected)).toEqual([]);
    expect(unexpectedFailures([{ file, title: "new failure" }], expected)).toHaveLength(1);
  });
});

describe("TAP parsing", () => {
  const file = "src/tests/addComment.test.ts";
  test("collects failing titles and skips passes", () => {
    const tap = "TAP version 13\n# Subtest: addComment\n    not ok 1 - posts a comment\n      ---\n    ok 2 - reads back\nnot ok 1 - addComment\n# tests 2\n# pass 1\n";
    expect(failedTitles(tap, file)).toEqual([
      { file, title: "posts a comment" },
      { file, title: "addComment" },
    ]);
  });
  test("a file-level failure is one (whole file) entry", () => {
    expect(failedTitles(`not ok 1 - ${file}\n`, file)).toEqual([{ file, title: "(whole file)" }]);
  });
  test("an absolute file-level failure is one (whole file) entry", () => {
    expect(failedTitles(`not ok 1 - /home/runner/work/repo/${file}\n`, file)).toEqual([{ file, title: "(whole file)" }]);
  });
});

describe("comment length", () => {
  const file = "src/kratos/index.ts";
  const source = "// one\n// two\n// three\n// four\n";
  test("catches an added four-line block in our code", () => {
    const diff = `diff --git a/${file} b/${file}\n+++ b/${file}\n@@ -0,0 +1,4 @@\n+// one\n+// two\n+// three\n+// four\n`;
    expect(scanSource(file, source, scanDiff(diff).get(file))).toEqual([{ file, line: 1, length: 4 }]);
  });
  test("an added `++x;` line does not end the file's hunk", () => {
    const diff = `diff --git a/${file} b/${file}\n+++ b/${file}\n@@ -0,0 +1,2 @@\n+++ count;\n+// one\n`;
    expect([...(scanDiff(diff).get(file) ?? [])]).toEqual([1, 2]);
  });
  test("three lines pass, upstream files are skipped", () => {
    expect(scanSource(file, "// one\n// two\n// three\n")).toEqual([]);
    expect(scanSource("src/tools/task-tools.ts", source)).toEqual([]);
  });
  test("an untouched block is not reported in a diff scan", () => {
    expect(scanSource(file, `x();\n${source}`, new Set([1]))).toEqual([]);
  });
  test("a shebang does not count, yml uses hash comments", () => {
    expect(scanSource(".github/scripts/run.sh", "#!/bin/sh\n# one\n# two\n# three\n")).toEqual([]);
    expect(scanSource(".github/workflows/kratos.yml", "# a\n# b\n# c\n# d\n")).toHaveLength(1);
  });
  test("yaml is scanned like yml", () => {
    expect(scanSource(".github/workflows/kratos.yaml", "# a\n# b\n# c\n# d\n")).toHaveLength(1);
  });
});

describe("file size", () => {
  const over = "x\n".repeat(1001);
  test("limits our code only", () => {
    expect(checkFile("src/kratos/large.ts", over)).toHaveLength(1);
    expect(checkFile("src/kratos/ok.ts", "x\n".repeat(1000))).toEqual([]);
    expect(checkFile("src/tools/task-tools.ts", over)).toEqual([]);
    expect(checkFile("docs/dev/playbook.md", over)).toEqual([]);
    expect(checkFile(".github/workflows/large.yaml", over)).toHaveLength(1);
  });
});

test("the kratos workflow leaves upstream CI alone and needs no secret", () => {
  const workflow = readFileSync(".github/workflows/kratos.yml", "utf8");
  expect(workflow).toContain("runs-on: ubuntu-latest");
  expect(workflow).not.toContain("secrets.");
  expect(workflow).not.toContain("self-hosted");
});
