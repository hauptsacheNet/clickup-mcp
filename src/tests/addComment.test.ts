import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("addComment posts comment to task", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (
      name: string,
      _desc: string,
      _schema: any,
      _opts: any,
      handler: any,
    ) => {
      tools[name] = handler;
    },
  } as any;

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.addComment({ task_id: "task123", comment: "Nice" });

  // Verify formatted comment blocks are sent instead of plain text
  assert.ok(Array.isArray(bodyCaptured.comment), "comment should be an array of blocks");
  assert.equal(bodyCaptured.comment.length, 1, "comment should have 1 block");
  assert.equal(bodyCaptured.comment[0].text, "Nice");
  assert.deepEqual(bodyCaptured.comment[0].attributes, {});
  assert.equal(bodyCaptured.notify_all, true);
  assert.ok(result.content[0].text.includes("Comment added successfully"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("addComment converts markdown formatting to ClickUp blocks", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/task/task123/comment", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "c1", user: { username: "me" }, date: "0" } };
    });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (
      name: string,
      _desc: string,
      _schema: any,
      _opts: any,
      handler: any,
    ) => {
      tools[name] = handler;
    },
  } as any;

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  await tools.addComment({
    task_id: "task123",
    comment: "This is **bold**, *italic*, and `code`"
  });

  // Verify formatted blocks
  assert.ok(Array.isArray(bodyCaptured.comment), "comment should be an array of blocks");

  // Find the bold block
  const boldBlock = bodyCaptured.comment.find((b: any) => b.text === "bold");
  assert.ok(boldBlock, "should have a bold block");
  assert.equal(boldBlock.attributes.bold, true, "bold block should have bold attribute");

  // Find the italic block
  const italicBlock = bodyCaptured.comment.find((b: any) => b.text === "italic");
  assert.ok(italicBlock, "should have an italic block");
  assert.equal(italicBlock.attributes.italic, true, "italic block should have italic attribute");

  // Find the code block
  const codeBlock = bodyCaptured.comment.find((b: any) => b.text === "code");
  assert.ok(codeBlock, "should have a code block");
  assert.equal(codeBlock.attributes.code, true, "code block should have code attribute");

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
