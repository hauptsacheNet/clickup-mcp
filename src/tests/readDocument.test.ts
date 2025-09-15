import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("readDocument fetches document and page content", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerDocumentToolsRead } = await import("../tools/doc-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v3/workspaces/team1/docs/doc123", method: "GET" })
    .reply(200, { id: "doc123", name: "Doc Title" });

  client
    .intercept({
      path: "/api/v3/workspaces/team1/docs/doc123/pageListing",
      method: "GET",
    })
    .reply(200, [
      { id: "page1", name: "Page One", doc_id: "doc123", pages: [] },
    ]);

  client
    .intercept({
      path: "/api/v3/workspaces/team1/docs/doc123/pages/page1",
      method: "GET",
    })
    .reply(200, { id: "page1", name: "Page One", content: "Hello" });

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

  const result = await tools.readDocument({ doc_id: "doc123" });
  const text = result.content.map((b: any) => b.text || "").join("\n");
  assert.ok(text.includes("doc_id: doc123"));
  assert.ok(text.includes("Page Content"));

  await mockAgent.close();
  t.mock.timers.reset();
});
