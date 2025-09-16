import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("searchDocuments returns matching documents", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerDocumentToolsRead } = await import("../tools/doc-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, { spaces: [{ id: "s1", name: "Space" }] });

  client
    .intercept({ path: /\/api\/v3\/workspaces\/team1\/docs.*/, method: "GET" })
    .reply(200, { docs: [{ id: "doc1", name: "Spec", parent: { type: 4, id: "s1" }, date_created: "0" }] });

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

  registerDocumentToolsRead(serverStub);

  const result = await tools.searchDocuments({ terms: ["Spec"] });
  const text = result.content.map((b: any) => b.text || "").join("\n");
  assert.ok(text.includes("Spec"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
