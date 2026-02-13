import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("searchSpaces fetches spaces and related content", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerSpaceTools } = await import("../tools/space-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, {
      spaces: [
        { id: "s1", name: "Alpha", archived: false },
        { id: "s2", name: "Beta", archived: false },
      ],
    });

  // Content fetches for space s1 (only matching space)
  client
    .intercept({ path: "/api/v2/space/s1/folder", method: "GET" })
    .reply(200, { folders: [] });
  client
    .intercept({ path: "/api/v2/space/s1/list", method: "GET" })
    .reply(200, { lists: [] });
  client
    .intercept({
      path: "/api/v3/workspaces/team1/docs?parent_id=s1",
      method: "GET",
    })
    .reply(200, { docs: [] });

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

  registerSpaceTools(serverStub);

  const result = await tools.searchSpaces({ terms: ["Alpha"] });
  const text = result.content.map((b: any) => b.text || "").join("\n");
  assert.ok(text.includes("SPACE: Alpha"));

  await mockAgent.close();
  t.mock.timers.reset();
});

test("searchSpaces with folder_id returns folder details", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerSpaceTools } = await import("../tools/space-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  // GET /folder/{id} returns folder metadata without lists
  client
    .intercept({ path: "/api/v2/folder/folder123", method: "GET" })
    .reply(200, {
      id: "folder123",
      name: "My Folder",
      archived: false,
      space: { id: "s1", name: "Alpha" },
    });

  // GET /folder/{id}/list returns the folder's lists
  client
    .intercept({ path: "/api/v2/folder/folder123/list", method: "GET" })
    .reply(200, {
      lists: [
        {
          id: "list1",
          name: "Todo List",
          task_count: 5,
          statuses: [
            { status: "open" },
            { status: "in progress" },
            { status: "done" },
          ],
        },
        {
          id: "list2",
          name: "Bug List",
          task_count: 3,
          statuses: [],
        },
      ],
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

  registerSpaceTools(serverStub);

  const result = await tools.searchSpaces({ folder_id: "folder123" });
  const text = result.content.map((b: any) => b.text || "").join("\n");
  assert.ok(text.includes("FOLDER: My Folder"));
  assert.ok(text.includes("folder_id: folder123"));
  assert.ok(text.includes("Todo List"));
  assert.ok(text.includes("Bug List"));
  assert.ok(text.includes("Parent space: Alpha"));

  await mockAgent.close();
  t.mock.timers.reset();
});
