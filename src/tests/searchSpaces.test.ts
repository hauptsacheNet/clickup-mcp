import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

describe("searchSpaces", () => {

test("fetches spaces and related content", async (t) => {
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

test("resolves numeric terms as folder IDs and shows parent space with hint", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerSpaceTools } = await import("../tools/space-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  // Mock folder fetch - returns folder with space reference
  client
    .intercept({ path: "/api/v2/folder/29507532", method: "GET" })
    .reply(200, {
      id: "29507532",
      name: "Sprint Planning",
      space: { id: "s3", name: "Engineering" },
    });

  // Mock space details fetch
  client
    .intercept({ path: "/api/v2/space/s3", method: "GET" })
    .reply(200, { id: "s3", name: "Engineering", archived: false });

  // Mock space content fetches
  client
    .intercept({ path: "/api/v2/space/s3/folder", method: "GET" })
    .reply(200, {
      folders: [{ id: "29507532", name: "Sprint Planning", lists: [] }],
    });
  client
    .intercept({ path: "/api/v2/space/s3/list", method: "GET" })
    .reply(200, { lists: [] });
  client
    .intercept({
      path: "/api/v3/workspaces/team1/docs?parent_id=s3",
      method: "GET",
    })
    .reply(200, { docs: [] });

  // Mock folder list fetch (getSpaceContent fetches lists for each folder)
  client
    .intercept({ path: "/api/v2/folder/29507532/list", method: "GET" })
    .reply(200, { lists: [{ id: "l1", name: "Backlog", task_count: 5 }] });

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

  const result = await tools.searchSpaces({ terms: ["29507532"] });
  const text = result.content.map((b: any) => b.text || "").join("\n");

  // Verify folder hint is present
  assert.ok(text.includes("Matched folder: Sprint Planning"), "should contain folder hint");
  assert.ok(text.includes("folder_id: 29507532"), "should contain folder ID in hint");

  // Verify parent space tree is present
  assert.ok(text.includes("SPACE: Engineering"), "should contain parent space");

  await mockAgent.close();
  t.mock.timers.reset();
});

}); // end describe
