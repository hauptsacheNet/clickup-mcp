import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("getTimeEntries requests time entries for task", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTimeToolsRead } = await import("../tools/time-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({
      path: /\/api\/v2\/team\/team1\/time_entries\?.*task_id=task1.*/,
      method: "GET",
    })
    .reply(200, { data: [] });

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

  registerTimeToolsRead(serverStub);

  const result = await tools.getTimeEntries({ task_id: "task1" });
  assert.ok(result.content[0].text.includes("Time Entries Summary"));

  await mockAgent.close();
  t.mock.timers.reset();
});
