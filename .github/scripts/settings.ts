export const OUR_PATHS = [
  "src/kratos/**",
  ".github/**",
  "docs/**",
  "UPSTREAM.json",
  "UPSTREAM-PATCHES.md",
] as const;

// Upstream files that sit under one of our folders and stay theirs.
export const UPSTREAM_OWNED_IN_OUR_PATHS = [
  ".github/workflows/test.yml",
  ".github/workflows/release.yml",
] as const;

export const MAX_FILE_LINES = 1000;
export const MAX_COMMENT_LINES = 3;
export const CODE_LINES_PER_PR_LIMIT = 400;
// What `sh` makes of the upstream `src/**/*.test.ts` glob: no globstar, so one folder deep.
export const UPSTREAM_TEST_GLOB = "src/*/*.test.ts";
export const OUR_TESTS_ROOT = "src/kratos";
export const UPSTREAM_TEST_PRELOAD = "./src/tests/setup.ts";
export const LEDGER_FILE = "UPSTREAM-PATCHES.md";

export const CHECKED_SOURCE = /\.(?:ts|js|mjs|sh|ya?ml)$/;
export const HASH_COMMENT_SOURCE = /\.(?:sh|ya?ml)$/;

export function isOurPath(path: string): boolean {
  if ((UPSTREAM_OWNED_IN_OUR_PATHS as readonly string[]).includes(path)) return false;
  return OUR_PATHS.some((pattern) =>
    pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern
  );
}
