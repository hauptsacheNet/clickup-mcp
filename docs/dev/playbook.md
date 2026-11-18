# Development playbook

Our rules apply to `OUR_PATHS`, defined once in `.github/scripts/settings.ts`: `src/kratos/**`, `.github/**`, `docs/**`, `UPSTREAM.json` and `UPSTREAM-PATCHES.md`. Two upstream files sit under `.github/` and stay theirs (`UPSTREAM_OWNED_IN_OUR_PATHS`): `.github/workflows/test.yml` and `.github/workflows/release.yml`. Every other file belongs to upstream `hauptsacheNet/clickup-mcp`, including `src/index.ts`, `package.json`, `CLAUDE.md`, `CHANGELOG.md` and `manifest.json`.

## Rules

| Rule | Ours | Upstream reality | Decision and reason |
|---|---|---|---|
| Scope | Checks on the whole fleet repo | Upstream owns almost every file | **ADAPT:** checks run on `OUR_PATHS` only, so a new release keeps its files as they are. Every upstream edit gets a row in `UPSTREAM-PATCHES.md`. |
| Comments | One English line saying why, three lines at most | Long JSDoc blocks | **KEEP** for ours; **SKIP** upstream, so a release never needs its comments rewritten. |
| File size | At most `MAX_FILE_LINES` (1,000) lines | Some files are long | **KEEP** for ours; **SKIP** upstream files. |
| PR size | At most `CODE_LINES_PER_PR_LIMIT` (400) CODE lines | No limit | **ADAPT:** count `OUR_PATHS` plus the upstream files of a `seam` row added in the PR. A `temporary` row, the author's PR cherry-picked as written, counts 0, like a tag-only bump. Tests, Markdown and JSON are out. |
| Code style | Bun, our formatting | Double quotes, semicolons, Prettier, `node:test`, `ts-node`, `undici` `MockAgent` | **ADAPT:** our code uses upstream style so a seam reads the same as its neighbours; upstream files are never reformatted, which would conflict on every sync. `.github/scripts/` runs on Bun with `node:` modules only, so it needs no lockfile. |
| Layers | Downward imports, one contract per module | Flat `src/shared/`, `src/tools/` | **ADAPT:** `src/kratos/index.ts` is the contract; upstream files import only it, and only `src/index.ts` registers it. Layers, modules and the `architecture` check: `docs/architecture.md`. |
| Tests | `bun test` next to the code | `node:test` under `src/tests/`, ClickUp mocked with `MockAgent` | **ADAPT:** ours live under `src/kratos/` at least one folder deep (`src/kratos/tests/*.test.ts`), so `npm test` does not pick them up twice; ClickUp is mocked, never called live. |
| Lint and types | Typecheck | `tsc`, no lint step | **KEEP** typecheck: `npx tsc --noEmit`. |
| CI | Self-hosted fleet runner | `.github/workflows/test.yml` on `ubuntu-latest`, Node 20, `npm test` | **ADAPT:** our job `kratos` in `.github/workflows/kratos.yml` on GitHub-hosted `ubuntu-latest`, never a fleet runner, because an outside PR to a public repo would run code on our host. Upstream `test.yml` stays untouched. No step needs a secret. |
| Upstream tests | No expected-failure list | Tests may fail on a release | **ADAPT:** `upstream-tests.ts` compares failures with «Expected upstream failures» in `UPSTREAM-PATCHES.md`; only a `NEW` failure turns CI red. |
| Review chain | Codex, Copilot, `code-reviewer` | None | **KEEP:** Codex at most 2 rounds, Copilot once on the final head, `code-reviewer` last; findings answered in the PR. Commit status `review-verdicts` (`.github/workflows/review-verdicts.yml`) stays red while a Codex, Copilot, DeepSeek or final-review finding has no `fixed in <sha>` or `declined: <why>` answer from the PR author; a P3 note counts as answered. |
| Writer stamp | Every PR names its writer | None | **KEEP:** check `writer-stamp` (`.github/workflows/writer-stamp.yml`) fails while the PR body has no complete `<!-- writer-stamp v1 … -->` line (provider, model, effort, executor, profile). Both checks skip docs-only PRs. |
| Merge | Lanes `mergeGate` | No merge process | **ADAPT:** the admin squash-merges after the review chain. |
| Values | Named constants in a settings file | Inline values | **KEEP:** names live in `src/kratos/settings.ts`; check settings in `.github/scripts/settings.ts`. |
| Language | English artefacts | English | **KEEP** for ours; **SKIP** upstream. |

## Development flow

1. Cut a branch from `origin/main`. One change per PR, at most 400 CODE lines. A PR that edits an upstream file adds its ledger row to `UPSTREAM-PATCHES.md` in the same PR.
2. Install with `npm ci` on Node 20.
3. Run the checks CI runs, from the repo root:

```sh
bun test ./.github/scripts/__tests__
bun .github/scripts/upstream-tests.ts
find src/kratos -type f -name '*.test.ts' | xargs -r node --test -r ts-node/register -r ./src/tests/setup.ts
npx tsc --noEmit
bun .github/scripts/comment-length/cli.ts origin/main...HEAD
bun .github/scripts/pr-size.ts --range origin/main...HEAD
bun .github/scripts/pr-size.ts --range origin/main...HEAD --ledger
bun .github/scripts/file-size.ts
bun .github/scripts/architecture/cli.ts
```

4. Open the PR against `main` of `kratos-fixer/kratos-clickup-mcp-fork`. `CI` (upstream), `kratos` and `architecture` (ours) must be green before the review chain starts.
5. An upstream sync PR from the mirror branch `upstream-main` cannot add a ledger row, so a sync that brings a new upstream failure stays red and goes to the admin; it is never merged red. An expected failure that starts passing prints `NOW PASSING`, and the next sync PR removes its row.
