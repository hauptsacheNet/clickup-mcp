import { describe, expect, test } from "bun:test";
import { isDocsOnly } from "../github.ts";
import { CODEX_LOGIN, openFindings, summaryAnswers, type PrData } from "../review-verdicts/index.ts";
import { verdict } from "../review-verdicts/cli.ts";
import { stampProblem } from "../writer-stamp/index.ts";

const AUTHOR = "writer";
const HEAD = "a".repeat(40);
const SHA = "b".repeat(40);
const codexReview = { id: 1, user: { login: CODEX_LOGIN }, body: "review" };
const copilotReview = { id: 2, user: { login: "copilot-pull-request-reviewer[bot]" }, body: "" };
const finding = (id: number, review: number, login: string) => ({ id, pull_request_review_id: review, user: { login }, body: "**P2** bug" });
const reply = (to: number, body: string, login = AUTHOR) => ({ id: to + 1000, in_reply_to_id: to, user: { login }, body });

function pr(extra: Partial<PrData> = {}): PrData {
  return {
    author: AUTHOR, head: HEAD, reviews: [codexReview, copilotReview],
    comments: [finding(10, 1, CODEX_LOGIN), finding(20, 2, "Copilot")], issueComments: [], ...extra,
  };
}

describe("review-verdicts", () => {
  test("unanswered Codex and Copilot findings are open", () => {
    expect(openFindings(pr())).toEqual(["c10", "c20"]);
    expect(verdict(openFindings(pr()), false)).toEqual({ state: "failure", description: "open findings: c10, c20" });
  });

  test("author replies close findings; other users' replies do not", () => {
    const data = pr();
    data.comments.push(reply(10, `fixed in ${SHA.slice(0, 7)}`), reply(20, "declined: out of scope", "someone"));
    expect(openFindings(data)).toEqual(["c20"]);
    data.comments.push(reply(20, "declined: out of scope"));
    expect(openFindings(data)).toEqual([]);
    expect(verdict([], false)).toEqual({ state: "success", description: "no open findings" });
  });

  test("a reply that is not a verdict leaves the finding open", () => {
    const data = pr();
    data.comments.push(reply(10, "thanks, will look"), reply(20, `fixed in [bbbbbbb](https://github.com/o/r/commit/${SHA})`));
    expect(openFindings(data)).toEqual(["c10"]);
  });

  test("comments outside an AI review are not findings", () => {
    expect(openFindings(pr({ comments: [finding(30, 99, "human")] }))).toEqual([]);
  });

  test("summary comment answers by id", () => {
    const body = `<!-- review-verdicts -->\nc10: fixed in ${SHA.slice(0, 7)}\nc20 [P2] a.ts:1 text: declined: not a bug`;
    expect([...summaryAnswers([{ user: { login: AUTHOR }, body }], AUTHOR)]).toEqual(["c10", "c20"]);
    expect(openFindings(pr({ issueComments: [{ user: { login: "other" }, body }] }))).toEqual(["c10", "c20"]);
    expect(openFindings(pr({ issueComments: [{ user: { login: AUTHOR }, body }] }))).toEqual([]);
  });

  test("final review: open and P1/P2 notes are open, P3 notes and answered ids are not", () => {
    const review = (head: string) => ({ user: { login: AUTHOR }, body: [`<!-- final-review head=${head} task=t -->`, "<!-- final-review-data",
      "cr-1 [P1] a.ts:1 bug: open", "cr-2 [P3] a.ts:2 nit: noted", "cr-3 [P2] a.ts:3 risk: noted", "cr-4 [P2] a.ts:4 fixed one: fixed", "-->", "", "### text"].join("\n") });
    const base = { reviews: [], comments: [] };
    expect(openFindings(pr({ ...base, issueComments: [review(HEAD)] }))).toEqual(["cr-1", "cr-3"]);
    expect(openFindings(pr({ ...base, issueComments: [review(SHA)] }))).toEqual([]);
    const summary = { user: { login: AUTHOR }, body: "<!-- review-verdicts -->\ncr-1: declined: by design" };
    expect(openFindings(pr({ ...base, issueComments: [review(HEAD), summary] }))).toEqual(["cr-3"]);
  });

  test("final review without a data block keeps the check red", () => {
    const broken = { user: { login: AUTHOR }, body: `<!-- final-review head=${HEAD} task=t -->\n### text` };
    expect(openFindings(pr({ reviews: [], comments: [], issueComments: [broken] }))).toEqual(["final-review-malformed"]);
  });

  test("escalated or approach-wrong final review keeps the check red", () => {
    const review = (line: string) => ({ user: { login: AUTHOR }, body: [`<!-- final-review head=${HEAD} task=t -->`, "<!-- final-review-data", line, "-->"].join("\n") });
    const base = { reviews: [], comments: [] };
    expect(openFindings(pr({ ...base, issueComments: [review("ESCALATED: full review requested")] }))).toEqual(["final-review-escalated"]);
    expect(openFindings(pr({ ...base, issueComments: [review("APPROACH-WRONG: module — wrong place")] }))).toEqual(["final-review-approach-wrong"]);
  });

  test("DeepSeek body findings are open until answered in a summary", () => {
    const deepseek = { id: 7, user: { login: "bot" }, body: "<!-- deepseek-review head=x -->\nFindings outside the diff lines:\n- `a.ts:3` — P2 bug\n\n- `b.ts:?` — P3 nit" };
    const base = { reviews: [deepseek], comments: [] };
    expect(openFindings(pr(base))).toEqual(["r7-1", "r7-2"]);
    const summary = { user: { login: AUTHOR }, body: "<!-- review-verdicts -->\nr7-1: declined: wrong\nr7-2: declined: style" };
    expect(openFindings(pr({ ...base, issueComments: [summary] }))).toEqual([]);
  });

  test("docs-only PR passes without findings", () => {
    expect(verdict(["c10"], true).state).toBe("success");
  });
});

describe("docs-only scope", () => {
  test.each([
    [["README.md", "docs/a.md"], true],
    [["README.md", "src/a.ts"], false],
    [["UPSTREAM-PATCHES.md"], false],
    [[], false],
  ])("%p → %p", (paths, docs) => expect(isDocsOnly(paths)).toBe(docs));
});

describe("writer-stamp", () => {
  const stamp = (fields: string) => `Body\n\n<!-- writer-stamp v1 ${fields} -->\n> [!NOTE]`;
  const full = "provider=claude model=claude-opus-5-5 effort=medium executor=lane%20build profile=normal";

  test("a full stamp passes", () => expect(stampProblem(stamp(full))).toBeNull());
  test("no stamp fails", () => expect(stampProblem("written by Codex gpt/high, executor x")).toContain("missing writer stamp"));
  test("unknown or absent fields fail", () => {
    expect(stampProblem(stamp("provider=claude model=unknown effort=medium executor=x"))).toBe("incomplete writer stamp; missing model, profile");
  });
  test("a partial handover fails", () => {
    expect(stampProblem(stamp(`${full} fixed_provider=claude fixed_model=m`))).toBe("incomplete writer stamp; missing fixed_effort, fixed_executor");
    expect(stampProblem(stamp(`${full} handed_provider=codex handed_model=m handed_effort=high handed_executor=x`))).toBeNull();
  });
  test("a stamp that does not decode fails", () => expect(stampProblem(stamp("provider=%E0%A4%A"))).toContain("missing writer stamp"));
});
