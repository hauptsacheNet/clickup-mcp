# Upstream patches

Ledger of every upstream file this fork changes. Upstream: `hauptsacheNet/clickup-mcp`, pinned in `UPSTREAM.json`.

## Patches

| Id | Upstream files | Change | Why it cannot live in `src/kratos/` | Kind | Upstream tests it breaks |
|---|---|---|---|---|---|
| P1 | `src/shared/custom-fields.ts`, `src/tools/list-tools.ts`, `src/tools/task-tools.ts`, `src/tools/task-write-tools.ts`, `src/tests/custom-fields.test.ts`, `CHANGELOG.md`, `README.md`, `manifest.json` | Cherry-pick of https://github.com/hauptsacheNet/clickup-mcp/pull/38 as written: read and write task custom fields. | The author's own pending change: the day he merges it, the sync is a no-op instead of a second tool. | temporary | None |
| P2 | `src/shared/custom-fields.ts`, `src/shared/task-ids.ts`, `src/shared/task-types.ts`, `src/tools/list-tools.ts`, `src/tools/search-tools.ts`, `src/tools/task-tools.ts`, `src/tools/task-write-tools.ts`, `src/tools/time-tools.ts`, `src/tests/custom-fields.test.ts`, `src/tests/custom-task-ids.test.ts`, `src/tests/searchTasks.test.ts`, `src/tests/task-types.test.ts`, `CHANGELOG.md`, `README.md`, `manifest.json` | Cherry-pick of https://github.com/hauptsacheNet/clickup-mcp/pull/42 as written: task types. Not on `main` yet; the PR that lands it checks this row against its own diff. | The author's own pending change: the day he merges it, the sync is a no-op instead of a second tool. | temporary | None |
| P3 | `src/index.ts` | One import of `src/kratos/index.ts`, `registerKratosToolsRead(server)` in each mode branch and `registerKratosToolsWrite(server)` in the `write` branch. | Upstream registers every tool in `initializeServer`; a tool reaches the server only through that function. | seam | None |
| P5 | `src/tools/task-write-tools.ts`, `CHANGELOG.md` | `updateTask` gains `remove_assignees`, sent as `assignees.rem` next to `assignees.add`. | Removing an assignee belongs to the ordinary `updateTask` call, not to a separate tool. | seam | None |

`main` equals tag `v1.10.0` plus the rows above whose PRs have merged, and our paths (see `docs/dev/playbook.md`); a row whose PR is still open describes a pending change. Kind is `seam` (a permanent edit, counted in PR size) or `temporary` (the author's own PR or an upstream defect fixed locally, with its URL; counted as 0). The PR that edits an upstream file adds its row here in the same PR.

## Expected upstream failures

Measured 2026-11-18 on `main` = `v1.10.0` (`80bc6ba`), in the `kratos` CI job of https://github.com/kratos-fixer/clickup-mcp-fork/actions/runs/44217051069: `ubuntu-latest` (image `ubuntu-26.04`), Node `v20.20.2`, npm `10.8.2`. `bun .github/scripts/upstream-tests.ts` ran the 19 files `src/*/*.test.ts` matches: 88 tests, 88 pass. These tests fail on the untouched upstream tree; CI fails only on a test outside this list.

None.
