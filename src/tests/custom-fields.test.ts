import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

/**
 * `../shared/config` throws at import time when the API key/team are missing, so
 * every test sets the credentials BEFORE importing the module - the same pattern
 * the other test files use. Keep all imports dynamic for that reason.
 */
async function loadCustomFields() {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  return import("../shared/custom-fields");
}

const FIELDS = [
  { id: "f1", name: "🤝 Customer", type: "short_text", type_config: {} },
  {
    id: "f2",
    name: "🧩 Domain",
    type: "drop_down",
    type_config: {
      options: [
        { id: "o1", name: "Infra", orderindex: 0 },
        { id: "o2", name: "Network", orderindex: 1 },
      ],
    },
  },
  { id: "f3", name: "✍️ Customer Approval", type: "checkbox", type_config: {} },
  { id: "f4", name: "📅 Maintenance Window", type: "date", type_config: {} },
  { id: "f5", name: "🙋 Requester", type: "users", type_config: {} },
  { id: "f6", name: "🎯 Scope", type: "labels", type_config: { options: [{ id: "l1", label: "Reseau", orderindex: 0 }] } },
  { id: "f7", name: "📊 Progress", type: "automatic_progress", type_config: {} },
  { id: "f8", name: "🔗 Related", type: "tasks", type_config: {} },
];

function makeServerStub() {
  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  return { tools, serverStub };
}

test("normalizeFieldKey ignores emoji, case and accents", async () => {
  const { normalizeFieldKey } = await loadCustomFields();
  assert.equal(normalizeFieldKey("🤝 Customer"), "customer");
  assert.equal(normalizeFieldKey("📏  Complexity"), "complexity");
  assert.equal(normalizeFieldKey("⛔ Blocker Reason"), "blocker reason");
  assert.equal(normalizeFieldKey("✍️ Customer Approval"), "customer approval");
});

test("resolveCustomFields maps names to ids and coerces every supported type", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches, resolveCustomFields } = await loadCustomFields();
  clearCustomFieldCaches();

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(200, { fields: FIELDS });
  client.intercept({ path: "/api/v2/team", method: "GET" }).reply(200, {
    teams: [
      {
        id: "team1",
        members: [
          { user: { id: "u1", username: "me", email: "me@example.com" } },
          { user: { id: "u2", username: "Bob", email: "bob@example.com" } },
        ],
      },
    ],
  });

  const resolved = await resolveCustomFields("list123", [
    { name: "🤝 Customer", value: "Acme" },
    { name: "Domain", value: "Infra" },
    { name: "Customer Approval", value: true },
    { name: "Maintenance Window", value: "2026-01-02T03:04:05.000Z" },
    { name: "Requester", value: "bob@example.com" },
    { name: "🎯 Scope", value: ["Reseau"] },
    { name: "Related", value: ["t1", "t2"] },
  ]);

  assert.deepEqual(
    resolved.map((field) => ({ id: field.fieldId, value: field.value })),
    [
      { id: "f1", value: "Acme" },
      { id: "f2", value: "o1" },
      { id: "f3", value: true },
      { id: "f4", value: Date.parse("2026-01-02T03:04:05.000Z") },
      { id: "f5", value: { add: ["u2"], rem: [] } },
      { id: "f6", value: ["l1"] },
      { id: "f8", value: { add: ["t1", "t2"], rem: [] } },
    ]
  );

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("resolveCustomFields reports unknown fields and options with the valid values", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches, resolveCustomFields } = await loadCustomFields();
  clearCustomFieldCaches();

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(200, { fields: FIELDS });

  await assert.rejects(() => resolveCustomFields("list123", [{ name: "Nope", value: "x" }]), /Unknown custom field/);
  await assert.rejects(
    () => resolveCustomFields("list123", [{ name: "Domain", value: "Nope" }]),
    /Unknown option "Nope" for field "🧩 Domain".*Valid options: "Infra", "Network"/
  );

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("createTask sends resolved custom_fields in the create body", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches } = await loadCustomFields();
  clearCustomFieldCaches();

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client.intercept({ path: "/api/v2/user", method: "GET" }).reply(200, { user: { id: "u1", username: "me" } });
  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(200, { fields: FIELDS });
  client.intercept({ path: "/api/v2/team", method: "GET" }).reply(200, {
    teams: [{ id: "team1", members: [{ user: { id: "u2", username: "Bob", email: "bob@example.com" } }] }],
  });

  let bodyCaptured: any;
  client.intercept({ path: "/api/v2/list/list123/task", method: "POST" }).reply((opts) => {
    bodyCaptured = JSON.parse(String(opts.body));
    return {
      statusCode: 200,
      data: { id: "task999", name: "Acme", status: { status: "open" }, assignees: [{ id: "u1", username: "me" }], url: "https://app.clickup.com/t/task999" },
    };
  });

  const { tools, serverStub } = makeServerStub();
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.createTask({
    list_id: "list123",
    name: "Acme",
    custom_fields: [
      { name: "🤝 Customer", value: "Acme" },
      { name: "Domain", value: "Infra" },
      { name: "Requester", value: "bob@example.com" },
    ],
  });

  assert.deepEqual(bodyCaptured.custom_fields, [
    { id: "f1", value: "Acme" },
    { id: "f2", value: "o1" },
    { id: "f5", value: { add: ["u2"], rem: [] } },
  ]);
  assert.match(result.content[0].text, /Task created successfully/);
  assert.match(result.content[0].text, /custom_fields:/);
  assert.match(result.content[0].text, /🧩 Domain: Infra/);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask writes custom fields through the field endpoint", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches } = await loadCustomFields();
  clearCustomFieldCaches();

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client.intercept({ path: "/api/v2/user", method: "GET" }).reply(200, { user: { id: "u1", username: "me" } });
  client.intercept({ path: "/api/v2/task/task999?include_markdown_description=true", method: "GET" }).reply(200, {
    id: "task999",
    name: "Acme",
    status: { status: "open" },
    assignees: [],
    list: { id: "list123", name: "Customers" },
    markdown_description: "",
    tags: [],
  });
  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(200, { fields: FIELDS });

  let fieldBody: any;
  let fieldPath = "";
  client.intercept({ path: "/api/v2/task/task999/field/f2", method: "POST" }).reply((opts) => {
    fieldPath = String(opts.path);
    fieldBody = JSON.parse(String(opts.body));
    return { statusCode: 200, data: {} };
  });

  // Refresh after the write (no PUT body, only custom fields).
  client.intercept({ path: "/api/v2/task/task999", method: "GET" }).reply(200, {
    id: "task999",
    name: "Acme",
    status: { status: "open" },
    assignees: [],
    list: { id: "list123", name: "Customers" },
    tags: [],
  });

  const { tools, serverStub } = makeServerStub();
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.updateTask({
    task_id: "task999",
    custom_fields: [{ name: "Domain", value: "Network" }],
  });

  assert.equal(fieldPath, "/api/v2/task/task999/field/f2");
  assert.deepEqual(fieldBody, { value: "o2" });
  assert.match(result.content[0].text, /Task updated successfully/);
  assert.match(result.content[0].text, /🧩 Domain: Network/);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("createTask aborts on an unknown custom field without creating the task", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches } = await loadCustomFields();
  clearCustomFieldCaches();

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  client.intercept({ path: "/api/v2/user", method: "GET" }).reply(200, { user: { id: "u1", username: "me" } });
  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(200, { fields: FIELDS });

  const { tools, serverStub } = makeServerStub();
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.createTask({
    list_id: "list123",
    name: "Should not exist",
    custom_fields: [{ name: "Unknown Field", value: "x" }],
  });

  assert.match(result.content[0].text, /Error creating task: Unknown custom field/);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("formatCustomFieldReadValue resolves users, labels and drop_down names", async () => {
  const { formatCustomFieldReadValue } = await loadCustomFields();
  assert.equal(
    formatCustomFieldReadValue({ type: "drop_down", value: 1, type_config: { options: FIELDS[1].type_config.options } }),
    "Network"
  );
  assert.equal(
    formatCustomFieldReadValue({ type: "users", value: [{ id: "u2", username: "Bob" }], type_config: {} }),
    "Bob"
  );
  assert.equal(
    formatCustomFieldReadValue({ type: "labels", value: ["l1"], type_config: { options: FIELDS[5].type_config.options } }),
    "Reseau"
  );
  assert.equal(formatCustomFieldReadValue({ type: "short_text", value: "" }), null);
});

test("getListCustomFields tool lists fields, options and writability", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches } = await loadCustomFields();
  clearCustomFieldCaches();

  const { registerListToolsRead } = await import("../tools/list-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  mockAgent
    .get("https://api.clickup.com")
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, { fields: FIELDS });

  const tools: Record<string, any> = {};
  let toolDescription = "";
  const serverStub = {
    tool: (name: string, desc: string, _schema: any, _opts: any, handler: any) => {
      if (name === "getListCustomFields") {
        toolDescription = desc;
      }
      tools[name] = handler;
    },
  } as any;
  registerListToolsRead(serverStub);

  const result = await tools.getListCustomFields({ list_id: "list123" });
  const text = result.content[0].text;

  assert.match(text, /🧩 Domain \[drop_down\]/);
  assert.match(text, /options: Infra \[o1\] \| Network \[o2\]/);
  assert.match(text, /📊 Progress \[automatic_progress\].*read-only/);
  // The tool description must document the partial-name matching rule.
  assert.match(toolDescription, /PARTIAL/i);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("an unknown field id fails even when a valid name is supplied", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches, resolveCustomFields } = await loadCustomFields();
  clearCustomFieldCaches();

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  mockAgent
    .get("https://api.clickup.com")
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, { fields: FIELDS });

  await assert.rejects(
    () => resolveCustomFields("list123", [{ id: "does-not-exist", name: "Customer", value: "x" }]),
    /Unknown custom field id "does-not-exist"/
  );

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("null clears a text field and is rejected for a users field", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches, resolveCustomFields } = await loadCustomFields();
  clearCustomFieldCaches();

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  mockAgent
    .get("https://api.clickup.com")
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, { fields: FIELDS });

  const [cleared] = await resolveCustomFields("list123", [{ name: "Customer", value: null }]);
  assert.equal(cleared.value, null);
  assert.equal(cleared.display, "(cleared)");

  // A users field cannot be cleared from a null alone (the `rem` half needs the
  // current members), and the rejection happens before any team API call.
  await assert.rejects(
    () => resolveCustomFields("list123", [{ name: "Requester", value: null }]),
    /is a users field - pass \{ add: \[\.\.\.\], rem: \[\.\.\.\] \}/
  );

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("a rejected list-field fetch is not cached", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches, getListCustomFields } = await loadCustomFields();
  clearCustomFieldCaches();

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(500, {});
  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(200, { fields: FIELDS });

  await assert.rejects(() => getListCustomFields("list123"), /Error fetching custom fields for list list123/);
  await Promise.resolve();

  const fields = await getListCustomFields("list123");
  assert.equal(fields.length, FIELDS.length);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("normalizeFieldKey keeps non-Latin letters so option matching cannot bleed", async (t) => {
  t.mock.timers.enable();
  const { normalizeFieldKey, clearCustomFieldCaches, resolveCustomFields } = await loadCustomFields();
  clearCustomFieldCaches();

  assert.equal(normalizeFieldKey("顧客"), "顧客");
  assert.equal(normalizeFieldKey("Kunde 客户"), "kunde 客户");
  assert.equal(normalizeFieldKey("🤝"), "");

  const cjkFields = [
    {
      id: "c1",
      name: "顧客",
      type: "drop_down",
      type_config: {
        options: [
          { id: "x1", name: "高", orderindex: 0 },
          { id: "x2", name: "Low", orderindex: 1 },
        ],
      },
    },
  ];

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  mockAgent
    .get("https://api.clickup.com")
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, { fields: cjkFields });

  const [resolved] = await resolveCustomFields("list123", [{ name: "顧客", value: "高" }]);
  assert.equal(resolved.value, "x1");

  // Before the fix, "中" normalized to "" and matched the only non-Latin option.
  await assert.rejects(() => resolveCustomFields("list123", [{ name: "顧客", value: "中" }]), /Unknown option "中"/);
  // An emoji-only value normalizes to "" - reject it instead of matching.
  await assert.rejects(() => resolveCustomFields("list123", [{ name: "顧客", value: "🤝" }]), /Unknown option "🤝"/);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("a tasks field is written as an {add, rem} diff and cannot be cleared with null", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches, resolveCustomFields } = await loadCustomFields();
  clearCustomFieldCaches();

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  mockAgent
    .get("https://api.clickup.com")
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, { fields: FIELDS });

  const [diff] = await resolveCustomFields("list123", [{ name: "Related", value: { add: ["t3"], rem: ["t1"] } }]);
  assert.deepEqual(diff.value, { add: ["t3"], rem: ["t1"] });

  await assert.rejects(
    () => resolveCustomFields("list123", [{ name: "Related", value: null }]),
    /is a tasks field - pass \{ add: \[\.\.\.\], rem: \[\.\.\.\] \}/
  );

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask keeps the custom-field result when the refresh fails", async (t) => {
  t.mock.timers.enable();
  const { clearCustomFieldCaches } = await loadCustomFields();
  clearCustomFieldCaches();

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client.intercept({ path: "/api/v2/user", method: "GET" }).reply(200, { user: { id: "u1", username: "me" } });
  client.intercept({ path: "/api/v2/task/task999?include_markdown_description=true", method: "GET" }).reply(200, {
    id: "task999",
    name: "Acme",
    status: { status: "open" },
    assignees: [],
    list: { id: "list123", name: "Customers" },
    markdown_description: "",
    tags: [],
  });
  client.intercept({ path: "/api/v2/list/list123/field", method: "GET" }).reply(200, { fields: FIELDS });
  client.intercept({ path: "/api/v2/task/task999/field/f2", method: "POST" }).reply(200, {});
  // The refresh after the write fails - the write itself must still be reported.
  client.intercept({ path: "/api/v2/task/task999", method: "GET" }).reply(503, {});

  const { tools, serverStub } = makeServerStub();
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.updateTask({
    task_id: "task999",
    custom_fields: [{ name: "Domain", value: "Network" }],
  });
  const text = result.content[0].text;

  assert.match(text, /🧩 Domain: Network/);
  assert.match(text, /refresh_warnings: Failed to refresh task: 503/);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
