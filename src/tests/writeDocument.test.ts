import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("updateDocumentPage updates existing page", async (t) => {
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
    .intercept({ path: "/api/v3/workspaces/team1/docs/doc123/pages/page1", method: "PUT" })
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

  const result = await tools.updateDocumentPage({
    doc_id: "doc123",
    page_id: "page1",
    name: "Updated",
    content: "Hello"
  });

  assert.equal(bodyCaptured.name, "Updated");
  assert.equal(bodyCaptured.content, "Hello");
  assert.equal(bodyCaptured.content_edit_mode, "replace");
  assert.ok(result.content[0].text.includes("Successfully updated page"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateDocumentPage appends content when append=true", async (t) => {
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
    .intercept({ path: "/api/v3/workspaces/team1/docs/doc123/pages/page1", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { page: { id: "page1", name: "Page", doc_id: "doc123" } } };
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

  const result = await tools.updateDocumentPage({
    doc_id: "doc123",
    page_id: "page1",
    content: "More content",
    append: true
  });

  assert.equal(bodyCaptured.content, "More content");
  assert.equal(bodyCaptured.content_edit_mode, "append");
  assert.ok(result.content[0].text.includes("Successfully updated page"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("createDocumentOrPage creates new document in space", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerDocumentToolsWrite } = await import("../tools/doc-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  let docBodyCaptured: any;
  let pageBodyCaptured: any;

  client
    .intercept({ path: "/api/v3/workspaces/team1/docs", method: "POST" })
    .reply((opts) => {
      docBodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "newdoc123", name: "New Doc" } };
    });

  client
    .intercept({ path: "/api/v3/workspaces/team1/docs/newdoc123/pages", method: "POST" })
    .reply((opts) => {
      pageBodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { page: { id: "newpage1", name: "New Doc" } } };
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

  const result = await tools.createDocumentOrPage({
    space_id: "space123",
    name: "New Doc",
    content: "Doc content"
  });

  assert.equal(docBodyCaptured.name, "New Doc");
  assert.equal(docBodyCaptured.parent.id, "space123");
  assert.equal(docBodyCaptured.parent.type, 4); // 4 = Space
  assert.equal(pageBodyCaptured.name, "New Doc");
  assert.equal(pageBodyCaptured.content, "Doc content");
  assert.ok(result.content[0].text.includes("Successfully created new document"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("createDocumentOrPage adds page to existing document", async (t) => {
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
    .intercept({ path: "/api/v3/workspaces/team1/docs/doc123/pages", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { page: { id: "newpage2", name: "New Page" } } };
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

  const result = await tools.createDocumentOrPage({
    doc_id: "doc123",
    name: "New Page",
    content: "Page content"
  });

  assert.equal(bodyCaptured.name, "New Page");
  assert.equal(bodyCaptured.content, "Page content");
  assert.ok(result.content[0].text.includes("Successfully created page"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
