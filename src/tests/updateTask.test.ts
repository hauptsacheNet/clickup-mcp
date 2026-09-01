import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("updateTask updates name and description", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Old", markdown_description: "existing", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task123", name: "New Name", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" } };
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

  const result = await tools.updateTask({ task_id: "task123", name: "New Name", append_description: "More details" });

  assert.equal(bodyCaptured.name, "New Name");
  assert.ok(bodyCaptured.markdown_description.includes("More details"));
  assert.ok(result.content[0].text.includes("Task updated successfully"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask removes only the links left out of linked_tasks", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });

  // Two existing links, one recorded in each direction: the API stores
  // `task_id`/`link_id` and puts the task being read on either side.
  const linkedTasks = [
    { task_id: "keepme", link_id: "task123" },
    { task_id: "task123", link_id: "dropme" },
  ];

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123", linked_tasks: linkedTasks });

  let removed: string[] = [];
  client
    .intercept({ path: "/api/v2/task/task123/link/dropme", method: "DELETE" })
    .reply(() => {
      removed.push("dropme");
      return { statusCode: 200, data: {} };
    });

  client
    .intercept({ path: "/api/v2/task/task123", method: "GET" })
    .reply(200, { id: "task123", name: "Task", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123", linked_tasks: [linkedTasks[0]] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  // Only `keepme` is requested, so only `dropme` may be removed. Nothing else is
  // intercepted, so an attempt to re-add `keepme` or to delete
  // `/link/undefined` fails the test instead of passing silently.
  const result = await tools.updateTask({ task_id: "task123", linked_tasks: ["keepme"] });

  assert.deepEqual(removed, ["dropme"]);
  assert.ok(result.content[0].text.includes("Task updated successfully"));
  assert.ok(!result.content[0].text.includes("dependency_warnings"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
