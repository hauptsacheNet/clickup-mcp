import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

const HOUR = 60 * 60 * 1000;

/**
 * Only setTimeout is mocked: the module caches (current user, agent cleanup) are
 * cleared by running the pending timers, while the edit window check needs a real
 * Date.now() to compare against the comment timestamps below.
 */
function enableTimers(t: any) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

function makeServerStub(tools: Record<string, any>) {
  return {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
}

/**
 * Mock agent with the two GETs every editComment call makes up front.
 * Each entry of `pages` is one page of the comment list, newest first.
 */
function setupClient(...pages: any[][]) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  pages.forEach((comments, index) => {
    if (index === 0) {
      client
        .intercept({ path: "/api/v2/task/task123/comment", method: "GET" })
        .reply(200, { comments });
      return;
    }
    // Older pages are requested with the last comment of the previous page
    const previous = pages[index - 1];
    const last = previous[previous.length - 1];
    client
      .intercept({
        path: `/api/v2/task/task123/comment?start=${last.date}&start_id=${last.id}`,
        method: "GET",
      })
      .reply(200, { comments });
  });

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: 42, username: "me" } });

  return { mockAgent, client };
}

function ownComment(overrides: Record<string, any> = {}) {
  return {
    id: "c1",
    date: String(Date.now() - HOUR),
    comment_text: "Original text",
    user: { id: 42, username: "me" },
    reply_count: 0,
    ...overrides,
  };
}

test("editComment PUTs formatted blocks for a recent own comment", async (t) => {
  enableTimers(t);
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");
  const { mockAgent, client } = setupClient([ownComment()]);

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/comment/c1", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: {} };
    });

  const tools: Record<string, any> = {};
  registerTaskToolsWrite(makeServerStub(tools), { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: "Corrected **bold** text",
  });

  assert.ok(Array.isArray(bodyCaptured.comment), "comment should be an array of blocks");
  const boldBlock = bodyCaptured.comment.find((b: any) => b.text === "bold");
  assert.ok(boldBlock, "formatting must survive the edit");
  assert.equal(boldBlock.attributes.bold, true);
  // Sending comment_text alongside comment appends it instead of being ignored
  assert.equal(bodyCaptured.comment_text, undefined, "comment_text must not be sent");

  const text = result.content[0].text;
  assert.ok(text.includes("Comment edited successfully"), text);
  assert.ok(text.includes("previous_text: Original text"), text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("editComment pages past the newest 25 comments to find the target", async (t) => {
  enableTimers(t);
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  // A full first page of newer comments, with the target only on page two
  const firstPage = Array.from({ length: 25 }, (_, i) =>
    ownComment({ id: `newer${i}`, date: String(Date.now() - i * 60 * 1000) })
  );
  const { mockAgent, client } = setupClient(firstPage, [ownComment()]);

  let putCalled = false;
  client
    .intercept({ path: "/api/v2/comment/c1", method: "PUT" })
    .reply(() => {
      putCalled = true;
      return { statusCode: 200, data: {} };
    });

  const tools: Record<string, any> = {};
  registerTaskToolsWrite(makeServerStub(tools), { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: "Found on page two",
  });

  assert.ok(putCalled, "the comment on page two must actually be edited");
  assert.ok(result.content[0].text.includes("Comment edited successfully"), result.content[0].text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("editComment stops paging once a page ends outside the edit window", async (t) => {
  enableTimers(t);
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  // The page ends 30h back, so nothing editable can follow - a request for a
  // second page is not intercepted and would fail the test.
  const { mockAgent } = setupClient([
    ownComment({ id: "newer", date: String(Date.now() - HOUR) }),
    ownComment({ id: "older", date: String(Date.now() - 30 * HOUR) }),
  ]);

  const tools: Record<string, any> = {};
  registerTaskToolsWrite(makeServerStub(tools), { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: "Not reachable",
  });

  const text = result.content[0].text;
  assert.ok(/2 top-level comment\(s\) checked across 1 page\(s\)/.test(text), text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("editComment refuses comments outside the edit window", async (t) => {
  enableTimers(t);
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");
  const { mockAgent } = setupClient([
    ownComment({ date: String(Date.now() - 30 * HOUR) }),
  ]);
  // No PUT is intercepted: reaching the API at all would fail the test

  const tools: Record<string, any> = {};
  registerTaskToolsWrite(makeServerStub(tools), { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: "Too late",
  });

  const text = result.content[0].text;
  assert.ok(/outside the 24 hour edit window/.test(text), text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("editComment refuses comments written by someone else", async (t) => {
  enableTimers(t);
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");
  const { mockAgent } = setupClient([
    ownComment({ user: { id: 99, username: "Someone Else" } }),
  ]);

  const tools: Record<string, any> = {};
  registerTaskToolsWrite(makeServerStub(tools), { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: "Not mine",
  });

  const text = result.content[0].text;
  assert.ok(/written by Someone Else \(user_id: 99\)/.test(text), text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("editComment reports an unknown comment id and hints at threaded replies", async (t) => {
  enableTimers(t);
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");
  // Second page comes back empty, which ends the search
  const { mockAgent } = setupClient([ownComment({ id: "other", reply_count: 3 })], []);

  const tools: Record<string, any> = {};
  registerTaskToolsWrite(makeServerStub(tools), { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: "Where is it",
  });

  const text = result.content[0].text;
  assert.ok(/was not found on task task123/.test(text), text);
  assert.ok(/threaded replies/.test(text), text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("editComment keeps the old comment when an image is broken", async (t) => {
  enableTimers(t);
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");
  const { mockAgent } = setupClient([ownComment()]);
  // Neither an attachment upload nor the PUT is intercepted

  const tools: Record<string, any> = {};
  registerTaskToolsWrite(makeServerStub(tools), { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: "Fixed it ![proof](/nope/missing-screenshot.png)",
  });

  const text = result.content[0].text;
  assert.ok(/the comment was NOT changed/.test(text), text);
  assert.ok(/missing-screenshot\.png/.test(text), text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
