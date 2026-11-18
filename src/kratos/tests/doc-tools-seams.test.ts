import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

const PAGE_PATH = "/api/v3/workspaces/team1/docs/doc123/pages/page1";

async function updatePage(t: any, args: Record<string, unknown>) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerDocumentToolsWrite } = await import("../../tools/doc-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const bodies: any[] = [];
  mockAgent
    .get("https://api.clickup.com")
    .intercept({ path: PAGE_PATH, method: "PUT" })
    .reply((opts) => {
      bodies.push(JSON.parse(String(opts.body)));
      return { statusCode: 200, data: { page: { id: "page1", name: "Page", doc_id: "doc123" } } };
    })
    .persist();

  const tools: Record<string, any> = {};
  registerDocumentToolsWrite({
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any);

  const result = await tools.updateDocumentPage({ doc_id: "doc123", page_id: "page1", ...args });

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
  return { result, bodies };
}

test("updateDocumentPage sends content_edit_mode prepend when prepend=true", async (t) => {
  const { result, bodies } = await updatePage(t, { content: "Top line", prepend: true });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].content, "Top line");
  assert.equal(bodies[0].content_edit_mode, "prepend");
  assert.ok(result.content[0].text.includes("Successfully updated page"));
});

test("updateDocumentPage without prepend still sends append when append=true", async (t) => {
  const { bodies } = await updatePage(t, { content: "Tail", append: true });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].content_edit_mode, "append");
});

test("updateDocumentPage without prepend or append sends replace", async (t) => {
  const { bodies } = await updatePage(t, { content: "Whole page" });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].content_edit_mode, "replace");
});

test("updateDocumentPage with append and prepend both true sends nothing", async (t) => {
  const { result, bodies } = await updatePage(t, { content: "X", append: true, prepend: true });

  assert.equal(bodies.length, 0);
  assert.match(result.content[0].text, /either 'append' or 'prepend'/);
});

test("updateDocumentPage with prepend but no content or name keeps the at-least-one error", async (t) => {
  const { result, bodies } = await updatePage(t, { prepend: true });

  assert.equal(bodies.length, 0);
  assert.match(result.content[0].text, /At least one of 'name' or 'content'/);
});
