import { afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

let api: typeof import("../index");
let config: typeof import("../../../shared/config");
let agent: MockAgent;

const ORIGIN = "https://api.clickup.com";

function headerValue(headers: unknown, name: string): string | undefined {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    }
    return undefined;
  }
  const record = (headers ?? {}) as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : record[key];
}

interface Captured {
  path: string;
  method: string;
  headers: unknown;
  body: unknown;
}

function capture(path: string | ((p: string) => boolean), method: string, status = 200, data: unknown = {}) {
  const seen: Captured[] = [];
  agent
    .get(ORIGIN)
    .intercept({ path, method })
    .reply((opts) => {
      seen.push({ path: opts.path, method: opts.method, headers: opts.headers, body: opts.body });
      return { statusCode: status, data: data as any };
    });
  return seen;
}

async function rejection(promise: Promise<unknown>): Promise<InstanceType<typeof api.ClickUpApiError>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof api.ClickUpApiError, `expected ClickUpApiError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to reject");
}

before(async () => {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  api = await import("../index");
  config = await import("../../../shared/config");
});

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

describe("clickupJson requests", () => {
  test("sends the env token as Authorization and builds the bracket query", async () => {
    const seen = capture(() => true, "GET", 200, { tasks: [] });
    const result = await api.clickupGet(`${api.CLICKUP_V2_BASE}/list/l1/task`, {
      statuses: ["a", "b"],
      page: 0,
      archived: false,
      skipped: undefined,
    });
    assert.deepEqual(result, { tasks: [] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/api/v2/list/l1/task?statuses%5B%5D=a&statuses%5B%5D=b&page=0&archived=false");
    assert.equal(headerValue(seen[0].headers, "authorization"), "test-key");
    assert.equal(headerValue(seen[0].headers, "content-type"), undefined);
    assert.equal(seen[0].body ?? undefined, undefined);
  });

  test("keeps a query already in the url and adds no pair for an empty array", async () => {
    const seen = capture(() => true, "GET");
    await api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1/comment?limit=10`, { statuses: [], page: 2 });
    assert.equal(seen[0].path, "/api/v2/task/t1/comment?limit=10&page=2");
  });

  test("workspaceUrl and teamUrl read CONFIG.teamId at call time", async () => {
    const seen = capture("/api/v3/workspaces/team1/docs", "GET");
    await api.clickupGet(api.workspaceUrl("/docs"));
    assert.equal(seen.length, 1);
    assert.equal(api.teamUrl("/space"), "https://api.clickup.com/api/v2/team/team1/space");

    config.CONFIG.teamId = "team2";
    try {
      assert.equal(api.workspaceUrl("/docs"), "https://api.clickup.com/api/v3/workspaces/team2/docs");
      assert.equal(api.teamUrl("/space"), "https://api.clickup.com/api/v2/team/team2/space");
    } finally {
      config.CONFIG.teamId = "team1";
    }
  });

  test("POST carries Content-Type and the JSON body", async () => {
    const seen = capture("/api/v2/task/t1/comment", "POST", 200, { id: "c1" });
    const result = await api.clickupPost(`${api.CLICKUP_V2_BASE}/task/t1/comment`, { comment_text: "hi" });
    assert.deepEqual(result, { id: "c1" });
    assert.equal(headerValue(seen[0].headers, "content-type"), "application/json");
    assert.equal(headerValue(seen[0].headers, "authorization"), "test-key");
    assert.deepEqual(JSON.parse(String(seen[0].body)), { comment_text: "hi" });
  });

  test("PUT sends its body with the PUT method", async () => {
    const seen = capture("/api/v2/comment/c1", "PUT");
    await api.clickupPut(`${api.CLICKUP_V2_BASE}/comment/c1`, { resolved: true });
    assert.equal(seen[0].method, "PUT");
    assert.equal(String(seen[0].body), '{"resolved":true}');
  });

  test("DELETE answered 204 resolves to {}", async () => {
    agent.get(ORIGIN).intercept({ path: "/api/v2/tag/x", method: "DELETE" }).reply(204, "");
    assert.deepEqual(await api.clickupDelete(`${api.CLICKUP_V2_BASE}/tag/x`), {});
  });

  test("200 with an empty body resolves to {}", async () => {
    agent.get(ORIGIN).intercept({ path: "/api/v2/task/t1", method: "PUT" }).reply(200, "");
    assert.deepEqual(await api.clickupPut(`${api.CLICKUP_V2_BASE}/task/t1`, { name: "n" }), {});
  });

  test("200 with an HTML body throws kind response", async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: "/api/v2/task/t1", method: "GET" })
      .reply(200, "<html><body>Maintenance</body></html>", { headers: { "content-type": "text/html" } });
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`));
    assert.equal(error.kind, "response");
    assert.equal(error.status, 200);
    assert.equal(error.detail, "<html><body>Maintenance</body></html>");
    assert.ok(error.message.endsWith("ClickUp answered with a body that is not JSON."));
  });

  test("no interceptor throws kind network with status 0", async () => {
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/missing?x=1`));
    assert.equal(error.kind, "network");
    assert.equal(error.status, 0);
    assert.equal(error.path, "/api/v2/task/missing");
    assert.ok(error.detail.length > 0);
    assert.ok(error.message.startsWith("ClickUp GET /api/v2/task/missing failed with no response: "));
    assert.ok(error.message.endsWith(". ClickUp could not be reached."));
  });
});

describe("ClickUp error statuses", () => {
  const rows = [
    { status: 401, body: { err: "Token invalid", ECODE: "OAUTH_025" }, kind: "unauthorized", ecode: "OAUTH_025", detail: "Token invalid" },
    { status: 403, body: { err: "Team not authorized", ECODE: "OAUTH_027" }, kind: "forbidden", ecode: "OAUTH_027", detail: "Team not authorized" },
    { status: 404, body: { err: "Task not found", ECODE: "ITEM_013" }, kind: "not_found", ecode: "ITEM_013", detail: "Task not found" },
    { status: 500, body: { message: "Internal error" }, kind: "server", ecode: undefined, detail: "Internal error" },
    { status: 503, body: "Service Unavailable from upstream", kind: "server", ecode: undefined, detail: "Service Unavailable from upstream" },
    { status: 400, body: { err: "Invalid body", ECODE: "INPUT_005" }, kind: "request", ecode: "INPUT_005", detail: "Invalid body" },
    { status: 402, body: { err: "Plan limit" }, kind: "request", ecode: undefined, detail: "Plan limit" },
    { status: 409, body: { err: "Conflict" }, kind: "request", ecode: undefined, detail: "Conflict" },
    { status: 400, body: {}, kind: "request", ecode: undefined, detail: "Bad Request" },
  ] as const;

  for (const row of rows) {
    test(`${row.status} ${JSON.stringify(row.body)} -> ${row.kind}`, async () => {
      agent.get(ORIGIN).intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(row.status, row.body as any);
      const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`));
      assert.equal(error.name, "ClickUpApiError");
      assert.equal(error.kind, row.kind);
      assert.equal(error.status, row.status);
      assert.equal(error.ecode, row.ecode);
      assert.equal(error.detail, row.detail);
      assert.equal(error.method, "GET");
      assert.equal(error.path, "/api/v2/task/t1");
      assert.equal(error.rateLimitResetAt, undefined);
    });
  }

  test("401 message follows the contract", async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: "/api/v2/task/t1?include=1", method: "GET" })
      .reply(401, { err: "Token invalid", ECODE: "OAUTH_025" });
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`, { include: 1 }));
    assert.equal(
      error.message,
      "ClickUp GET /api/v2/task/t1 failed with HTTP 401 (OAUTH_025): Token invalid. ClickUp rejected the token in CLICKUP_API_KEY.",
    );
  });

  test("error body that is not JSON gives the cut text as detail", async () => {
    const long = "x".repeat(api.CLICKUP_ERROR_BODY_MAX_CHARS + 50);
    agent.get(ORIGIN).intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(502, long);
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`));
    assert.equal(error.kind, "server");
    assert.equal(error.detail, "x".repeat(api.CLICKUP_ERROR_BODY_MAX_CHARS));
    assert.equal(error.ecode, undefined);
    assert.ok(error.message.startsWith("ClickUp GET /api/v2/task/t1 failed with HTTP 502: x"));
  });

  test("429 with the reset header carries rateLimitResetAt and the retry time", async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: "/api/v2/task/t1", method: "GET" })
      .reply(429, { err: "Rate limit reached", ECODE: "APP_002" }, { headers: { [api.CLICKUP_RATE_RESET_HEADER]: "1700000000" } });
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`));
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.status, 429);
    assert.equal(error.ecode, "APP_002");
    assert.equal(error.detail, "Rate limit reached");
    assert.equal(error.rateLimitResetAt, 1700000000 * 1000);
    assert.equal(
      error.message,
      "ClickUp GET /api/v2/task/t1 failed with HTTP 429 (APP_002): Rate limit reached. The per-minute ClickUp request limit is spent. Retry after 2023-11-14T22:13:20.000Z.",
    );
  });

  test("429 without the reset header has no retry time", async () => {
    agent.get(ORIGIN).intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(429, { err: "Rate limit reached" });
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`));
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.rateLimitResetAt, undefined);
    assert.equal(error.message.includes("Retry after"), false);
  });

  test("clickupErrorKind maps every status class", () => {
    const table: [number, string][] = [
      [401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"],
      [500, "server"], [599, "server"], [400, "request"], [402, "request"], [409, "request"], [422, "request"],
    ];
    for (const [status, kind] of table) assert.equal(api.clickupErrorKind(status), kind, String(status));
  });
});

describe("tool results", () => {
  test("toolText joins lines with a newline", () => {
    assert.deepEqual(api.toolText(["a", "b"]), { content: [{ type: "text", text: "a\nb" }] });
  });

  test("toolError on a 401 error is flagged and never carries the token", async (t) => {
    t.mock.method(console, "error", () => {});
    agent
      .get(ORIGIN)
      .intercept({ path: "/api/v2/comment/c1", method: "PUT" })
      .reply(401, { err: "Token invalid", ECODE: "OAUTH_025" });
    const error = await rejection(api.clickupPut(`${api.CLICKUP_V2_BASE}/comment/c1`, { resolved: true }));
    const result = api.toolError("resolving comment", error);
    assert.equal(result.isError, true);
    const text = String(result.content[0].text);
    assert.ok(text.startsWith("Error resolving comment: ClickUp PUT /api/v2/comment/c1 failed with HTTP 401 (OAUTH_025)"));
    assert.equal(text.includes("test-key"), false);
  });

  test("toolError on a non-Error value uses its string form", (t) => {
    t.mock.method(console, "error", () => {});
    assert.deepEqual(api.toolError("reading task", "boom"), {
      content: [{ type: "text", text: "Error reading task: boom" }],
      isError: true,
    });
  });
});

describe("the token never reaches a message", () => {
  test("a low-level cause that lists the request headers is redacted", async (t) => {
    t.mock.method(console, "error", () => {});
    // MockAgent names the request headers when only the header match fails.
    agent
      .get(ORIGIN)
      .intercept({ path: "/api/v2/task/t1", method: "GET", headers: { authorization: "other" } })
      .reply(200, {});
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`));
    assert.equal(error.kind, "network");
    assert.ok(error.detail.includes("[redacted]"), error.detail);
    assert.equal(error.message.includes("test-key"), false);
    assert.equal(String(api.toolError("reading task", error).content[0].text).includes("test-key"), false);
  });

  test("an error body echoing the token is redacted", async () => {
    agent.get(ORIGIN).intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(400, { err: "bad key test-key" });
    const error = await rejection(api.clickupGet(`${api.CLICKUP_V2_BASE}/task/t1`));
    assert.equal(error.detail, "bad key [redacted]");
    assert.equal(error.message.includes("test-key"), false);
  });

  test("toolError strips the token from a foreign error", (t) => {
    t.mock.method(console, "error", () => {});
    const text = String(api.toolError("reading task", new Error("header test-key leaked")).content[0].text);
    assert.equal(text, "Error reading task: header [redacted] leaked");
  });
});
