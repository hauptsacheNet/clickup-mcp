import { test } from "node:test";
import assert from "node:assert/strict";

// config.ts reads env at import time; isTaskId lives in the same module.
process.env.CLICKUP_API_KEY = "test-key";
process.env.CLICKUP_TEAM_ID = "team1";

test("isTaskId accepts default IDs of any modern length and custom IDs", async () => {
  const { isTaskId } = await import("../shared/utils");

  // Default IDs: ClickUp grows the length over time (9 -> 10 -> 11+).
  for (const id of ["abcdef", "86ahzfw4z", "wdrv93ebwx", "wdrv93ebwf", "a1b2c3d4e5f6"]) {
    assert.equal(isTaskId(id), true, `expected default ID to be accepted: ${id}`);
  }

  // Custom IDs: a letter-led prefix, a hyphen, then digits.
  for (const id of ["GH-123", "PROJ-1234", "AB-1", "gh-99"]) {
    assert.equal(isTaskId(id), true, `expected custom ID to be accepted: ${id}`);
  }
});

test("isTaskId stays selective: ordinary terms are not mistaken for IDs", async () => {
  const { isTaskId } = await import("../shared/utils");

  // Hyphenated words must NOT match the custom-ID branch (no digit suffix) so the
  // search-tools direct-fetch fallback isn't triggered for normal search terms.
  for (const term of ["follow-up", "to-do", "re-run", "wip-task", "note-x"]) {
    assert.equal(isTaskId(term), false, `expected hyphenated term to be rejected: ${term}`);
  }

  // Below the 6-char floor.
  for (const term of ["abc", "task", "wip", "id"]) {
    assert.equal(isTaskId(term), false, `expected sub-floor term to be rejected: ${term}`);
  }
});
