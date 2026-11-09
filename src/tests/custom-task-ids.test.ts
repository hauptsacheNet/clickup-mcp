import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

/**
 * Custom Task IDs (issue #25): workspaces with the Custom Task IDs ClickApp address
 * tasks as PREFIX-NUMBER (e.g. ENG-302). Every tool that takes a task accepts them and
 * resolves them once via `?custom_task_ids=true&team_id=...` to the generated ID.
 */

function stubServer() {
  const tools: Record<string, any> = {};
  const schemas: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
      schemas[name] = schema;
    },
  } as any;
  return { tools, schemas, serverStub };
}

test("isCustomTaskId tells custom IDs apart from generated IDs", async () => {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { isCustomTaskId } = await import("../shared/task-ids");

  assert.equal(isCustomTaskId("ENG-302"), true);
  assert.equal(isCustomTaskId("dev-1"), true, "case-insensitive");
  assert.equal(isCustomTaskId("ABC2-12345"), true, "prefixes may contain digits");
  assert.equal(isCustomTaskId("86ey1qwck"), false, "generated IDs have no hyphen");
  assert.equal(isCustomTaskId("CU-86ey1qwck"), false, "CU- prefixed generated IDs are not custom IDs");
  assert.equal(isCustomTaskId("https://app.clickup.com/t/ENG-302"), false);
  assert.equal(isCustomTaskId("302-ENG"), false);
});

test("task ID schema accepts generated and custom IDs, rejects the rest", async () => {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { taskIdSchema } = await import("../shared/task-ids");
  const schema = taskIdSchema("test");

  assert.equal(schema.safeParse("ENG-302").success, true, "custom IDs are shorter than the old 6 char minimum allows for");
  assert.equal(schema.safeParse("z8nrz7c746").success, true);
  assert.equal(schema.safeParse("ENG").success, false);
  assert.equal(schema.safeParse("#ENG-302").success, false);
  assert.equal(schema.safeParse("https://app.clickup.com/t/86ey1qwck").success, false);
});

test("updateTask resolves a custom task ID and writes to the generated ID", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client.intercept({ path: "/api/v2/user", method: "GET" }).reply(200, { user: { id: "u1", username: "me" } });

  let lookups = 0;
  client
    .intercept({ path: "/api/v2/task/ENG-302?custom_task_ids=true&team_id=team1", method: "GET" })
    .reply(() => {
      lookups++;
      return { statusCode: 200, data: { id: "abc123xyz", custom_id: "ENG-302" } };
    });

  client
    .intercept({ path: "/api/v2/task/abc123xyz?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "abc123xyz", custom_id: "ENG-302", name: "Old", markdown_description: "", status: { status: "open" }, assignees: [], url: "https://app.clickup.com/t/abc123xyz", list: { id: "list1" } });

  let putBody: any;
  client
    .intercept({ path: "/api/v2/task/abc123xyz", method: "PUT" })
    .reply((opts) => {
      putBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "abc123xyz", name: "New", status: { status: "open" }, assignees: [], url: "https://app.clickup.com/t/abc123xyz" } };
    });

  const { tools, schemas, serverStub } = stubServer();
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  assert.equal(schemas.updateTask.task_id.safeParse("ENG-302").success, true);

  const result = await tools.updateTask({ task_id: "ENG-302", name: "New" });

  assert.equal(lookups, 1);
  assert.equal(putBody.name, "New");
  assert.ok(result.content[0].text.includes("Task updated successfully"), result.content[0].text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("an unknown custom task ID fails clearly and writes nothing", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/task/ENG-999?custom_task_ids=true&team_id=team1", method: "GET" })
    .reply(404, { err: "Task not found", ECODE: "ITEM_015" });

  const { tools, serverStub } = stubServer();
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.addComment({ task_id: "ENG-999", comment: "hello" });

  assert.ok(result.content[0].text.includes('Custom Task ID "ENG-999" could not be resolved'), result.content[0].text);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
