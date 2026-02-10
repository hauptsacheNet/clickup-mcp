import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("getFolderInfo fetches folder details and lists", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerFolderToolsRead } = await import("../tools/list-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({
      path: "/api/v2/folder/folder123",
      method: "GET",
    })
    .reply(200, {
      id: "folder123",
      name: "My Folder",
      space: { id: "space1", name: "SpaceA" },
      archived: false,
      hidden: false,
      lists: [
        { id: "list1", name: "List One", task_count: 5, archived: false },
        { id: "list2", name: "List Two", task_count: 0, archived: true },
      ],
      statuses: [
        { status: "Open", type: "open" },
        { status: "In Progress", type: "custom" },
        { status: "Closed", type: "closed" },
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

  registerFolderToolsRead(serverStub);

  const result = await tools.getFolderInfo({ folder_id: "folder123" });
  const text = result.content[0].text;
  assert.ok(text.includes("folder_id: folder123"));
  assert.ok(text.includes("name: My Folder"));
  assert.ok(text.includes("space: SpaceA (space_id: space1)"));
  assert.ok(text.includes("Lists in this folder (2 total)"));
  assert.ok(text.includes("List One (list_id: list1, 5 tasks)"));
  assert.ok(text.includes("List Two (list_id: list2, archived)"));
  assert.ok(text.includes("Available statuses (3 total)"));
  assert.ok(text.includes("Open (open)"));
  assert.ok(text.includes("In Progress (custom)"));
  assert.ok(text.includes("Closed (closed)"));

  await mockAgent.close();
  t.mock.timers.reset();
});
