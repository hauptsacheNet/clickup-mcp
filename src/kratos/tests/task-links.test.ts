import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

// Guards the upstream `updateTask` `linked_tasks` diff: only the difference is sent.
function setup() {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });
  return { mockAgent, client };
}

function task(linked_tasks: any[]) {
  return { id: "task123", name: "Task", markdown_description: "", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123", linked_tasks };
}

async function registerTools() {
  const { registerTaskToolsWrite } = await import("../../tools/task-write-tools");
  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });
  return tools;
}

test("updateTask linked_tasks adds only the new link", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client } = setup();
  const existing = [{ task_id: "task123", link_id: "keep" }];

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, task(existing));

  let added = 0;
  client
    .intercept({ path: "/api/v2/task/task123/link/new", method: "POST" })
    .reply(() => {
      added++;
      return { statusCode: 200, data: {} };
    });

  client
    .intercept({ path: "/api/v2/task/task123", method: "GET" })
    .reply(200, task([...existing, { task_id: "task123", link_id: "new" }]));

  const tools = await registerTools();
  const result = await tools.updateTask({ task_id: "task123", linked_tasks: ["keep", "new"] });

  assert.equal(added, 1);
  assert.ok(result.content[0].text.includes("Task updated successfully"));
  assert.ok(!result.content[0].text.includes("dependency_warnings"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask linked_tasks removes only the dropped link, either record direction", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client } = setup();
  const existing = [
    { task_id: "keep", link_id: "task123" },
    { task_id: "task123", link_id: "drop" },
  ];

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, task(existing));

  let removed = 0;
  client
    .intercept({ path: "/api/v2/task/task123/link/drop", method: "DELETE" })
    .reply(() => {
      removed++;
      return { statusCode: 200, data: {} };
    });

  client
    .intercept({ path: "/api/v2/task/task123", method: "GET" })
    .reply(200, task([existing[0]]));

  const tools = await registerTools();
  const result = await tools.updateTask({ task_id: "task123", linked_tasks: ["keep"] });

  assert.equal(removed, 1);
  assert.ok(result.content[0].text.includes("Task updated successfully"));
  assert.ok(!result.content[0].text.includes("dependency_warnings"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
