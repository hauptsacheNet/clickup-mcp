import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("writeDocument updates existing page", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerDocumentToolsWrite } = await import("../tools/doc-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v3/docs/pages/page1", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { page: { id: "page1", name: "Updated", doc_id: "doc123" } } };
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

  registerDocumentToolsWrite(serverStub);

  const result = await tools.writeDocument({ page_id: "page1", page_name: "Updated", content: "Hello" });

  assert.equal(bodyCaptured.name, "Updated");
  assert.equal(bodyCaptured.content, "Hello");
  assert.ok(result.content[0].text.includes("Successfully updated page"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
