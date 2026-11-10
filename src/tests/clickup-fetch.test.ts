import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClickUpRateLimitError,
  clickupFetch,
  __resetClickUpFetchState,
  __clickUpFetchStateSize,
} from "../shared/clickup-fetch";
import { runWithCredentials } from "../shared/request-context";

const realFetch = globalThis.fetch;
const URL_OF = (user: string, n = 0) => `https://api.clickup.com/api/v2/task/t${n}?u=${user}`;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve)); // setImmediate is not mocked below

function reset(t: any) {
  __resetClickUpFetchState();
  delete process.env.CLICKUP_MAX_CONCURRENT_REQUESTS;
  delete process.env.CLICKUP_RATE_LIMIT_MAX_WAIT_SECONDS;
  t.after(() => {
    globalThis.fetch = realFetch;
    __resetClickUpFetchState();
    delete process.env.CLICKUP_MAX_CONCURRENT_REQUESTS;
    delete process.env.CLICKUP_RATE_LIMIT_MAX_WAIT_SECONDS;
  });
}

function asUser<T>(userKey: string, fn: () => T): T {
  return runWithCredentials({ token: "secret-token-" + userKey, teamId: "team1", userKey }, fn);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("limiter: never more than 6 in flight per user, and each user gets their own 6", async (t) => {
  reset(t);
  const inFlight: Record<string, number> = { a: 0, b: 0 };
  const peak: Record<string, number> = { a: 0, b: 0 };
  let peakTotal = 0;
  globalThis.fetch = (async (input: any) => {
    const user = new URL(String(input)).searchParams.get("u")!;
    inFlight[user]++;
    peak[user] = Math.max(peak[user], inFlight[user]);
    peakTotal = Math.max(peakTotal, inFlight.a + inFlight.b);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight[user]--;
    return json(200, { ok: true });
  }) as any;

  const calls = [
    ...Array.from({ length: 20 }, (_, i) => asUser("a", () => clickupFetch(URL_OF("a", i)))),
    ...Array.from({ length: 20 }, (_, i) => asUser("b", () => clickupFetch(URL_OF("b", i)))),
  ];
  const responses = await Promise.all(calls);
  assert.equal(responses.length, 40);
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(peak.a, 6);
  assert.equal(peak.b, 6);
  assert.equal(peakTotal, 12);
  assert.equal(__clickUpFetchStateSize(), 0, "idle users are dropped from the map");
});

test("limiter: CLICKUP_MAX_CONCURRENT_REQUESTS is honoured and queued calls run FIFO", async (t) => {
  reset(t);
  process.env.CLICKUP_MAX_CONCURRENT_REQUESTS = "1";
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = (async (input: any) => {
    started.push(Number(/\/t(\d+)/.exec(String(input))![1]));
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return json(200, {});
  }) as any;
  await Promise.all(Array.from({ length: 5 }, (_, i) => clickupFetch(URL_OF("x", i))));
  assert.equal(peak, 1);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
});

test("limiter: a call aborted while queued rejects and frees its place", async (t) => {
  reset(t);
  process.env.CLICKUP_MAX_CONCURRENT_REQUESTS = "1";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen: number[] = [];
  globalThis.fetch = (async (input: any) => {
    seen.push(Number(/\/t(\d+)/.exec(String(input))![1]));
    await gate;
    return json(200, {});
  }) as any;
  const first = clickupFetch(URL_OF("x", 0));
  const controller = new AbortController();
  const queued = clickupFetch(URL_OF("x", 1), { signal: controller.signal });
  const third = clickupFetch(URL_OF("x", 2));
  await flush();
  controller.abort();
  await assert.rejects(queued);
  release();
  await Promise.all([first, third]);
  assert.deepEqual(seen, [0, 2]);
});

test("passes every non-429 response through unchanged, without retrying", async (t) => {
  reset(t);
  let calls = 0;
  const statuses = [200, 404, 500];
  globalThis.fetch = (async () => json(statuses[calls++], { n: calls })) as any;
  for (const status of statuses) {
    const response = await clickupFetch(URL_OF("x"));
    assert.equal(response.status, status);
  }
  assert.equal(calls, 3);
});

test("429 then success: waits for Retry-After, retries, and logs exactly one line", async (t) => {
  reset(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const errors: string[] = [];
  // Node 20 also prints "MockTimers API is an experimental feature" through console.error
  // the first time mock timers are used, so only our own lines are collected.
  t.mock.method(console, "error", (...args: unknown[]) => {
    const line = args.join(" ");
    if (!line.includes("ExperimentalWarning")) errors.push(line);
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? json(429, { err: "Rate limit reached", ECODE: "APP_002" }, { "retry-after": "1" }) : json(200, { id: "t1" });
  }) as any;

  let result: Response | undefined;
  const pending = asUser("tokenuser", () => clickupFetch(URL_OF("x"))).then((r) => (result = r));
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(calls, 1, "still waiting before the Retry-After has passed");
  assert.equal(result, undefined);
  t.mock.timers.tick(251); // 1s plus up to 250ms of jitter
  await pending;
  assert.equal(calls, 2);
  assert.equal(result!.status, 200);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /^rate limit: user=\w{1,8} wait=1s path=\/api\/v2\/task\/t0$/);
  assert.ok(!errors[0].includes("secret-token"), "the token is never logged");
});

test("429 with a reset beyond the max wait throws ClickUpRateLimitError at once", async (t) => {
  reset(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(console, "error", () => undefined);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return json(429, { err: "Rate limit reached" }, {
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 37),
    });
  }) as any;

  await assert.rejects(clickupFetch(URL_OF("x")), (error: any) => {
    assert.ok(error instanceof ClickUpRateLimitError);
    assert.equal(error.retryAfterSeconds, 37);
    assert.equal(error.limit, 100);
    assert.equal(error.remaining, 0);
    assert.equal(
      error.message,
      "ClickUp rate limit reached for this user (100 requests/minute). Retry after 37s. Reduce parallel tool calls."
    );
    return true;
  });
  assert.equal(calls, 1, "no retry when the wait is too long");
});

test("Retry-After as an HTTP date is understood, and CLICKUP_RATE_LIMIT_MAX_WAIT_SECONDS is honoured", async (t) => {
  reset(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(console, "error", () => undefined);
  globalThis.fetch = (async () => json(429, {}, { "retry-after": new Date(Date.now() + 30_000).toUTCString() })) as any;
  await assert.rejects(clickupFetch(URL_OF("x")), (error: any) => {
    assert.ok(error instanceof ClickUpRateLimitError);
    assert.ok(error.retryAfterSeconds >= 29 && error.retryAfterSeconds <= 30, String(error.retryAfterSeconds));
    return true;
  });

  __resetClickUpFetchState();
  process.env.CLICKUP_RATE_LIMIT_MAX_WAIT_SECONDS = "60";
  let calls = 0;
  globalThis.fetch = (async () => (++calls === 1 ? json(429, {}, { "retry-after": "30" }) : json(200, {}))) as any;
  const pending = clickupFetch(URL_OF("x"));
  await flush();
  t.mock.timers.tick(30_250);
  assert.equal((await pending).status, 200);
});

test("gives up with ClickUpRateLimitError after 2 retries", async (t) => {
  reset(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(console, "error", () => undefined);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return json(429, {}, { "retry-after": "1" });
  }) as any;

  const pending = clickupFetch(URL_OF("x")).then(
    () => "resolved",
    (error) => error
  );
  for (let i = 0; i < 3; i++) {
    await flush();
    t.mock.timers.tick(1250);
  }
  const error = await pending;
  assert.ok(error instanceof ClickUpRateLimitError);
  assert.equal(calls, 3);
  assert.equal(error.retryAfterSeconds, 1);
});

test("paused user: a request queued during a 429 waits for the reset instead of firing", async (t) => {
  reset(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(console, "error", () => undefined);
  const firedAt: number[] = [];
  let first = true;
  globalThis.fetch = (async () => {
    firedAt.push(Date.now());
    if (first) {
      first = false;
      return json(429, {}, { "retry-after": "2" });
    }
    return json(200, {});
  }) as any;

  const a = clickupFetch(URL_OF("x", 0));
  await flush();
  assert.equal(firedAt.length, 1);
  // A second slot is free, but the user is paused until the reset
  const b = clickupFetch(URL_OF("x", 1));
  await flush();
  assert.equal(firedAt.length, 1, "B did not fire while the user is paused");

  t.mock.timers.tick(2250);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.equal(firedAt.length, 3);
  assert.ok(firedAt[1] >= 2000 && firedAt[2] >= 2000, "both retried after the reset");
});

test("paused user: a request queued behind a pause longer than the max wait fails fast without a request", async (t) => {
  reset(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(console, "error", () => undefined);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return json(429, {}, { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) });
  }) as any;

  await assert.rejects(clickupFetch(URL_OF("x", 0)), ClickUpRateLimitError);
  assert.equal(calls, 1);
  await assert.rejects(clickupFetch(URL_OF("x", 1)), (error: any) => {
    assert.ok(error instanceof ClickUpRateLimitError);
    assert.ok(error.retryAfterSeconds >= 59 && error.retryAfterSeconds <= 60);
    return true;
  });
  assert.equal(calls, 1, "no request was sent for the second call");

  // Another user is not affected by this user's pause
  globalThis.fetch = (async () => json(200, {})) as any;
  const other = await asUser("other", () => clickupFetch(URL_OF("o")));
  assert.equal(other.status, 200);
});
