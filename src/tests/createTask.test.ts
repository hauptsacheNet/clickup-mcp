import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("createTask posts task with defaults", async (t) => {
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

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/list/list123/task", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task999", name: "New Task", status: { status: "open" }, assignees: [{ id: "u1", username: "me" }], url: "https://app.clickup.com/t/task999" } };
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

  const result = await tools.createTask({ list_id: "list123", name: "New Task", description: "Desc" });

  assert.equal(bodyCaptured.name, "New Task");
  assert.equal(bodyCaptured.markdown_description, "Desc");
  assert.deepEqual(bodyCaptured.assignees, ["u1"]);
  assert.ok(result.content[0].text.includes("Task created successfully"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
