import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

/**
 * Task types ("custom items") on createTask / updateTask: custom_item_id takes the
 * numeric ID or the type's name, which resolves via GET /team/{id}/custom_item
 * before anything is written.
 */

const CUSTOM_ITEMS = { custom_items: [{ id: 1006, name: "Bug", name_plural: "Bugs" }, { id: 1001, name: "Milestone" }] };

function setup() {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  client.intercept({ path: "/api/v2/user", method: "GET" }).reply(200, { user: { id: "u1", username: "me" } }).persist();

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  return { mockAgent, client, tools, serverStub };
}

async function teardown(t: any, mockAgent: MockAgent) {
  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
}

test("createTask resolves a task type by name and sends it next to custom fields", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, tools, serverStub } = setup();
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client.intercept({ path: "/api/v2/list/listA/field", method: "GET" })
    .reply(200, { fields: [{ id: "f-notes", name: "Release Notes", type: "text" }] });
  client.intercept({ path: "/api/v2/team/team1/custom_item", method: "GET" }).reply(200, CUSTOM_ITEMS);

  let body: any;
  client.intercept({ path: "/api/v2/list/listA/task", method: "POST" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: { id: "new1", custom_id: "ENG-303", name: "Crash", status: { status: "open" }, assignees: [], url: "https://app.clickup.com/t/new1" } };
  });

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });
  const result = await tools.createTask({
    list_id: "listA",
    name: "Crash",
    custom_item_id: "bug",
    custom_fields: [{ name: "Release Notes", value: "Fixed the crash" }],
  });

  const text = result.content[0].text;
  assert.ok(text.includes("Task created successfully"), text);
  assert.equal(body.custom_item_id, 1006);
  assert.deepEqual(body.custom_fields, [{ id: "f-notes", value: "Fixed the crash" }]);
  assert.ok(text.includes("task_type: Bug (custom_item_id: 1006)"), text);

  await teardown(t, mockAgent);
});

test("createTask accepts a numeric task type and sends no custom fields", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, tools, serverStub } = setup();
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  let body: any;
  client.intercept({ path: "/api/v2/list/listB/task", method: "POST" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: { id: "new2", custom_id: "ENG-304", name: "X", status: { status: "open" }, assignees: [], url: "https://app.clickup.com/t/new2" } };
  });
  client.intercept({ path: "/api/v2/team/team1/custom_item", method: "GET" }).reply(200, CUSTOM_ITEMS);

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });
  await tools.createTask({ list_id: "listB", name: "X", custom_item_id: 1006 });

  assert.equal(body.custom_item_id, 1006);
  assert.equal(body.custom_fields, undefined);

  await teardown(t, mockAgent);
});

test("createTask rejects an unknown task type name with the available types and creates nothing", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, tools, serverStub } = setup();
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client.intercept({ path: "/api/v2/team/team1/custom_item", method: "GET" }).reply(200, CUSTOM_ITEMS);

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });
  const result = await tools.createTask({ list_id: "listD", name: "X", custom_item_id: "Epic" });

  assert.ok(result.content[0].text.includes('Unknown task type "Epic". Available task types: Task (0), Bug (1006), Milestone (1001)'), result.content[0].text);

  await teardown(t, mockAgent);
});

test("updateTask sends the task type in the update body", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, tools, serverStub } = setup();
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "T", markdown_description: "", status: { status: "open" }, assignees: [], url: "https://app.clickup.com/t/task123", list: { id: "listE" } });
  client.intercept({ path: "/api/v2/team/team1/custom_item", method: "GET" }).reply(200, CUSTOM_ITEMS);

  let putBody: any;
  client.intercept({ path: "/api/v2/task/task123", method: "PUT" }).reply((opts) => {
    putBody = JSON.parse(String(opts.body));
    return { statusCode: 200, data: { id: "task123", name: "T", status: { status: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" } };
  });

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });
  const result = await tools.updateTask({ task_id: "task123", custom_item_id: "Milestone" });

  const text = result.content[0].text;
  assert.ok(text.includes("Task updated successfully"), text);
  assert.deepEqual(putBody, { custom_item_id: 1001 });
  assert.ok(text.includes("task_type: Milestone (custom_item_id: 1001)"), text);

  await teardown(t, mockAgent);
});
