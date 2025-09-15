import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("getListInfo fetches list details and space tags", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerListToolsRead } = await import("../tools/list-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({
      path: "/api/v2/list/list123?include_markdown_description=true",
      method: "GET",
    })
    .reply(200, {
      id: "list123",
      name: "My List",
      folder: { name: "FolderA" },
      space: { id: "space1", name: "SpaceA" },
      archived: false,
      task_count: 0,
      markdown_description: "description",
      statuses: [
        { status: "Open", type: "open" },
        { status: "Closed", type: "done" },
      ],
    });

  client
    .intercept({ path: "/api/v2/space/space1/tag", method: "GET" })
    .reply(200, { tags: [{ name: "tag1" }] });

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

  registerListToolsRead(serverStub);

  const result = await tools.getListInfo({ list_id: "list123" });
  assert.ok(result.content[0].text.includes("list_id: list123"));
  assert.ok(result.content[0].text.includes("Available statuses"));

  await mockAgent.close();
  t.mock.timers.reset();
});
