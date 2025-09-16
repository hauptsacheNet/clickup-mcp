import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("searchTasks fetches missing task by id", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerSearchTools } = await import("../tools/search-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  // Task index requests
  client
    .intercept({ path: /\/api\/v2\/team\/team1\/task.*/, method: "GET" })
    .reply(200, { tasks: [] })
    .persist();

  // Direct fetch for task id not found in index
  let directHit = false;
  client
    .intercept({ path: "/api/v2/task/abc123", method: "GET" })
    .reply(200, () => {
      directHit = true;
      return {
        id: "abc123",
        name: "Fetched Task",
        creator: { username: "creator", id: "1" },
        assignees: [],
        list: { id: "list1", name: "List" },
        space: { id: "space1", name: "Space" },
        status: { status: "open", type: "open" },
        url: "https://app.clickup.com/t/abc123",
        date_created: "0",
        date_updated: "0",
      };
    });

  // Time entry helper calls
  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [] }] });

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

  registerSearchTools(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.searchTasks({ terms: ["abc123"] });
  assert.ok(directHit, "expected direct task fetch");
  assert.ok(result.content[0].text.includes("task_id: abc123"));

  await mockAgent.close();
  t.mock.timers.reset();
});

test("searchTasks uses paginated index with filters", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerSearchTools } = await import("../tools/search-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  // Paginated task index - two pages of results
  let page0Hit = false;
  let page1Hit = false;
  client
    .intercept({ path: /\/api\/v2\/team\/team1\/task.*page=0/, method: "GET" })
    .reply(200, () => {
      page0Hit = true;
      const base = {
        creator: { username: "creator", id: "1" },
        assignees: [],
        list: { id: "list1", name: "List" },
        space: { id: "space1", name: "Space 1" },
        status: { status: "open", type: "open" },
        date_created: "0",
        date_updated: "0",
      };
      return {
        tasks: [
          {
            ...base,
            id: "t1",
            name: "Bug report",
            url: "https://app.clickup.com/t/t1",
          },
          {
            ...base,
            id: "t2",
            name: "Feature request",
            url: "https://app.clickup.com/t/t2",
          },
          {
            ...base,
            id: "t3",
            name: "Another bug",
            url: "https://app.clickup.com/t/t3",
          },
        ],
      };
    });

  client
    .intercept({ path: /\/api\/v2\/team\/team1\/task.*page=1/, method: "GET" })
    .reply(200, () => {
      page1Hit = true;
      const base = {
        creator: { username: "creator", id: "1" },
        assignees: [],
        list: { id: "list1", name: "List" },
        space: { id: "space1", name: "Space 1" },
        status: { status: "open", type: "open" },
        date_created: "0",
        date_updated: "0",
      };
      return {
        tasks: [
          {
            ...base,
            id: "t4",
            name: "Bugfix followup",
            url: "https://app.clickup.com/t/t4",
          },
          {
            ...base,
            id: "t5",
            name: "Chore",
            url: "https://app.clickup.com/t/t5",
          },
        ],
      };
    });

  // Remaining pages return empty arrays
  client
    .intercept({ path: /\/api\/v2\/team\/team1\/task.*/, method: "GET" })
    .reply(200, { tasks: [] })
    .persist();

  // Time entry helper calls
  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [] }] });

  client
    .intercept({
      path: /\/api\/v2\/team\/team1\/time_entries.*list_id=list1/,
      method: "GET",
    })
    .reply(200, { data: [] });

  client
    .intercept({ path: "/api/v2/space/space1", method: "GET" })
    .reply(200, { id: "space1", name: "Space 1" });

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

  registerSearchTools(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.searchTasks({
    terms: ["bug"],
    list_ids: ["list1"],
    space_ids: ["space1"],
  });

  assert.ok(page0Hit && page1Hit, "expected to fetch multiple pages");
  const combinedText = result.content.map((b: any) => b.text || "").join("\n");
  assert.ok(combinedText.includes("task_id: t1"));
  assert.ok(combinedText.includes("task_id: t3"));
  assert.ok(combinedText.includes("task_id: t4"));

  await mockAgent.close();
  t.mock.timers.reset();
});
