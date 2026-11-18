import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

async function captureAssigneesBody(args: Record<string, unknown>) {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "", status: { status: "open", type: "open" }, assignees: [{ id: 42, username: "owner" }], url: "https://app.clickup.com/t/task123" });

  const puts: any[] = [];
  client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      puts.push(JSON.parse(String(opts.body)));
      return { statusCode: 200, data: { id: "task123", name: "Task", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" } };
    });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.updateTask({ task_id: "task123", ...args });
  await mockAgent.close();
  return { puts, text: result.content[0].text as string };
}

test("updateTask sends remove_assignees alone as rem with an empty add", async (t) => {
  t.mock.timers.enable();
  const { puts, text } = await captureAssigneesBody({ remove_assignees: ["42"] });

  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].assignees, { add: [], rem: ["42"] });
  assert.ok(text.includes("Task updated successfully"));

  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask sends assignees and remove_assignees in one PUT", async (t) => {
  t.mock.timers.enable();
  const { puts, text } = await captureAssigneesBody({ assignees: ["7"], remove_assignees: ["42"] });

  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].assignees, { add: ["7"], rem: ["42"] });
  assert.ok(text.includes("Task updated successfully"));

  t.mock.timers.runAll();
  t.mock.timers.reset();
});
