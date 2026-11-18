import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

process.env.CLICKUP_API_KEY = "test-key";
process.env.CLICKUP_TEAM_ID = "team1";
process.env.CLICKUP_MCP_MODE = "write";

const task = (id: string, status: string) => ({
  id,
  name: `Task ${id}`,
  status: { status },
  assignees: [{ id: 7, username: "kratos" }],
  url: `https://app.clickup.com/t/${id}`,
});

type Page = { status?: number; body: any };

// Serves `pages` in order for GET /list/L1/task and records every requested path.
function mockClickUp(pages: Page[]) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const paths: string[] = [];
  const pool = agent.get("https://api.clickup.com");
  for (const page of pages) {
    pool
      .intercept({ path: (path) => path.startsWith("/api/v2/list/L1/task?"), method: "GET" })
      .reply(page.status ?? 200, (request) => {
        paths.push(request.path);
        return page.body;
      });
  }
  return { agent, paths };
}

async function loadTool() {
  const { registerKratosToolsRead } = await import("../index");
  const tools: Record<string, any> = {};
  registerKratosToolsRead({ tool: (name: string, ...rest: any[]) => (tools[name] = rest[rest.length - 1]) } as any);
  return tools.listTasksByStatus;
}

const query = (path: string) => new URLSearchParams(path.split("?")[1]);

test("one page: tasks listed, no nextPage, closed statuses included", async () => {
  const { agent, paths } = mockClickUp([{ body: { tasks: [task("a1", "done")], last_page: true } }]);
  const listTasksByStatus = await loadTool();
  const result = await listTasksByStatus({ list_id: "L1", statuses: ["done", "in progress"], page: 0 });
  const text = result.content[0].text;
  assert.deepEqual(query(paths[0]).getAll("statuses[]"), ["done", "in progress"]);
  assert.equal(query(paths[0]).get("include_closed"), "true");
  assert.equal(query(paths[0]).get("page"), "0");
  assert.match(text, /Task a1 \(task_id: a1\)/);
  assert.match(text, /status: done/);
  assert.match(text, /kratos \(user_id: 7\)/);
  assert.match(text, /nextPage: none/);
  await agent.close();
});

test("two pages: nextPage while last_page is false, then none", async () => {
  const { agent, paths } = mockClickUp([
    { body: { tasks: [task("p0", "open")], last_page: false } },
    { body: { tasks: [task("p1", "open")], last_page: true } },
  ]);
  const listTasksByStatus = await loadTool();
  const first = await listTasksByStatus({ list_id: "L1", statuses: ["open"], page: 0 });
  assert.match(first.content[0].text, /nextPage: 1/);
  const second = await listTasksByStatus({ list_id: "L1", statuses: ["open"], page: 1 });
  assert.match(second.content[0].text, /Task p1/);
  assert.match(second.content[0].text, /nextPage: none/);
  assert.equal(query(paths[1]).get("page"), "1");
  await agent.close();
});

test("zero pages: an unknown status gives an empty result, not an error", async () => {
  const { agent } = mockClickUp([{ body: { tasks: [], last_page: true } }]);
  const listTasksByStatus = await loadTool();
  const result = await listTasksByStatus({ list_id: "L1", statuses: ["no such status"], page: 0 });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /tasks: 0/);
  await agent.close();
});

test("empty statuses ask for open tasks only; missing last_page ends the listing", async () => {
  const { agent, paths } = mockClickUp([{ body: { tasks: [task("o1", "open")] } }]);
  const listTasksByStatus = await loadTool();
  const result = await listTasksByStatus({ list_id: "L1", statuses: [], page: 0 });
  assert.equal(query(paths[0]).has("statuses[]"), false);
  assert.equal(query(paths[0]).has("include_closed"), false);
  assert.match(result.content[0].text, /statuses: all open/);
  assert.match(result.content[0].text, /nextPage: none/);
  await agent.close();
});

test("an API refusal is returned as a tool error", async () => {
  const { agent } = mockClickUp([{ status: 401, body: { err: "Token invalid" } }]);
  const listTasksByStatus = await loadTool();
  const result = await listTasksByStatus({ list_id: "L1", statuses: ["open"], page: 0 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /401/);
  await agent.close();
});

test("write mode registers every KRATOS_TOOLS name on the upstream server", async (t) => {
  t.mock.timers.enable();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const pool = agent.get("https://api.clickup.com");
  pool.intercept({ path: "/api/v2/user", method: "GET" }).reply(200, { user: { id: 1, username: "me", email: "me@x" } });
  pool.intercept({ path: "/api/v2/team/team1/space", method: "GET" }).reply(200, { spaces: [] });
  // Upstream skips the stdio connect when argv names its CLI.
  process.argv.push("cli.ts");
  const { serverPromise } = await import("../../index");
  const { KRATOS_TOOLS } = await import("../index");
  const server: any = await serverPromise;
  const registered = Object.keys(server._registeredTools);
  for (const name of KRATOS_TOOLS) assert.ok(registered.includes(name), `${name} not registered`);
  process.argv.pop();
  await agent.close();
  t.mock.timers.reset();
});
