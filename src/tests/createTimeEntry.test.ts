import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("createTimeEntry posts correct body", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTimeToolsWrite } = await import("../tools/time-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/team/team1/time_entries", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { data: { id: "e1", user: { username: "me" } } } };
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

  registerTimeToolsWrite(serverStub);

  const result = await tools.createTimeEntry({ task_id: "task1", hours: 2, description: "Work" });

  assert.equal(bodyCaptured.tid, "task1");
  assert.equal(bodyCaptured.duration, 2 * 60 * 60 * 1000);
  assert.ok(result.content[0].text.includes("Time entry created successfully"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
