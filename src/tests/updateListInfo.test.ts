import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("updateListInfo appends description", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerListToolsWrite } = await import("../tools/list-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/list/list123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "list123", name: "List", markdown_description: "existing" });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/list/list123", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: {} };
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

  registerListToolsWrite(serverStub);

  const result = await tools.updateListInfo({ list_id: "list123", append_description: "Extra" });

  assert.ok(bodyCaptured.markdown_content.includes("Extra"));
  assert.ok(bodyCaptured.markdown_content.includes("**Edit ("));
  assert.ok(result.content[0].text.includes("Successfully appended content"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
