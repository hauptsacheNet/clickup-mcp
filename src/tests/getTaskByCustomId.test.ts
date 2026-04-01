import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("getTaskByCustomId makes correct API calls with custom_task_ids param", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsRead } = await import("../tools/task-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [] }] });

  // The task endpoint should be called with custom_task_ids=true&team_id=team1
  client
    .intercept({
      path: (path: string) => {
        return (
          path.startsWith("/api/v2/task/DEV-42") &&
          path.includes("custom_task_ids=true") &&
          path.includes("team_id=team1")
        );
      },
      method: "GET",
    })
    .reply(200, {
      id: "abc123", // real task ID returned by API
      name: "Test Task",
      markdown_description: "",
      attachments: [],
      creator: { username: "creator", id: "1" },
      assignees: [],
      list: { id: "list1", name: "List" },
      space: { id: "space1", name: "Space" },
      status: { status: "open", type: "open" },
      url: "https://app.clickup.com/t/abc123",
      date_created: "0",
      date_updated: "0",
    });

  // Subsequent calls should use the real task ID (abc123)
  client
    .intercept({ path: /\/api\/v2\/task\/abc123\/comment.*/, method: "GET" })
    .reply(200, { comments: [] });

  client
    .intercept({ path: "/api/v2/task/abc123/time_in_status", method: "GET" })
    .reply(200, { status_history: [], current_status: null });

  client
    .intercept({
      path: /\/api\/v2\/team\/team1\/time_entries.*/,
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

  registerTaskToolsRead(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.getTaskByCustomId({ customId: "DEV-42" });
  assert.ok(
    result.content.some(
      (block: any) =>
        typeof block.text === "string" &&
        block.text.includes("task_id: abc123"),
    ),
  );

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});
