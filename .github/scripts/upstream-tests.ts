import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { LEDGER_FILE, UPSTREAM_TEST_GLOB, UPSTREAM_TEST_PRELOAD, isOurPath } from "./settings.ts";

export type Failure = { file: string; title: string };

export function expectedFailures(ledger: string): Set<string> {
  const expected = new Set<string>();
  let inSection = false;
  for (const line of ledger.split("\n")) {
    if (/^## /.test(line)) inSection = line.trim() === "## Expected upstream failures";
    const row = /^\| `(src\/[^`]+\.test\.ts)` \| (.*?) \|/.exec(line);
    if (inSection && row) expected.add(`${row[1]}|${row[2]}`);
  }
  return expected;
}

export function failedTitles(output: string, file: string): Failure[] {
  const failures: Failure[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*not ok \d+ - (.+?)(?: \{.*)?$/.exec(line);
    if (!match) continue;
    const title = match[1].trim();
    if (title === file || title.endsWith(`/${file}`) || file.endsWith(`/${title}`)) {
      if (!failures.length) failures.push({ file, title: "(whole file)" });
    } else failures.push({ file, title });
  }
  return failures;
}

export function unexpectedFailures(actual: Failure[], expected: Set<string>): Failure[] {
  return actual.filter(({ file, title }) => !expected.has(`${file}|${title}`));
}

export function matchesTestGlob(path: string): boolean {
  const [root, , name] = UPSTREAM_TEST_GLOB.split("/");
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === root && parts[2].endsWith(name.replace("*", "")) && !isOurPath(path);
}

function upstreamTestFiles(): string[] {
  const root = UPSTREAM_TEST_GLOB.split("/")[0];
  return readdirSync(root, { withFileTypes: true })
    .filter((dir) => dir.isDirectory())
    .flatMap((dir) => readdirSync(`${root}/${dir.name}`).map((file) => `${root}/${dir.name}/${file}`))
    .filter(matchesTestGlob)
    .sort();
}

if (import.meta.main) {
  const expected = expectedFailures(readFileSync(LEDGER_FILE, "utf8"));
  const failures: Failure[] = [];
  let commandErrors = 0;
  let tests = 0;
  let passed = 0;
  for (const file of upstreamTestFiles()) {
    const run = spawnSync(
      "node",
      ["--test", "--test-reporter=tap", "-r", "ts-node/register", "-r", UPSTREAM_TEST_PRELOAD, file],
      { encoding: "utf8", timeout: 150000, maxBuffer: 16 * 1024 * 1024 }
    );
    const output = run.stdout ?? "";
    tests += Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? 0);
    passed += Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0);
    const failed = failedTitles(output, file);
    failures.push(...failed);
    if (run.error || (run.status !== 0 && !failed.length)) {
      console.error(`${file}: ${run.error?.message || run.stderr?.trim() || "test command failed without TAP failure"}`);
      commandErrors++;
    }
  }
  const unknown = unexpectedFailures(failures, expected);
  const actual = new Set(failures.map(({ file, title }) => `${file}|${title}`));
  for (const failure of failures.filter(({ file, title }) => expected.has(`${file}|${title}`)))
    console.log(`EXPECTED ${failure.file}: ${failure.title}`);
  // A listed failure that passes now is reported, not failed; the next sync PR drops its row.
  for (const key of [...expected].filter((key) => !actual.has(key))) console.log(`NOW PASSING ${key.replace("|", ": ")}`);
  for (const failure of unknown) console.log(`NEW ${failure.file}: ${failure.title}`);
  console.log(
    `${tests} tests, ${passed} pass, ${failures.length} upstream failures, ${unknown.length} new failures, ${commandErrors} command errors`
  );
  process.exitCode = unknown.length || commandErrors ? 1 : 0;
}
