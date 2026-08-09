import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";
import { convertClickUpTextItemsToToolCallResult } from "../clickup-text";

const ATTACHMENT_URL =
  "https://t123.p.clickup-attachments.com/t123/abc-def/screenshot.png";

/**
 * The point of this file: what getTaskById renders for a comment must be usable as
 * editComment input. If reading and writing drift apart, an agent that reads a comment
 * and hands it back unchanged silently drops the images.
 */
test("a comment read back as markdown keeps its image when passed to editComment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  // 1. Read: the fragments ClickUp returns for a comment with an image
  const blocks = await convertClickUpTextItemsToToolCallResult([
    { text: "Ist umgesetzt:\n" },
    {
      type: "image",
      image: {
        url: ATTACHMENT_URL,
        name: "screenshot.png",
        thumbnail_large: ATTACHMENT_URL,
      },
    },
    { text: "\nBitte prüfen.\n" },
  ]);

  const readBack = blocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  assert.ok(
    readBack.includes(`![screenshot.png](${ATTACHMENT_URL})`),
    `the image must be readable as markdown, got: ${readBack}`
  );

  // 2. Write: hand exactly that text back to editComment
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/task/task123/comment", method: "GET" })
    .reply(200, {
      comments: [
        {
          id: "c1",
          date: String(Date.now() - 60 * 1000),
          comment_text: "Ist umgesetzt:",
          user: { id: 42, username: "me" },
        },
      ],
    });
  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: 42, username: "me" } });

  // No attachment upload is intercepted: re-uploading the image would fail this test
  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/comment/c1", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: {} };
    });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _d: any, _s: any, _o: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: 42 } });

  const result = await tools.editComment({
    task_id: "task123",
    comment_id: "c1",
    comment: readBack,
  });

  assert.ok(
    result.content[0].text.includes("Comment edited successfully"),
    result.content[0].text
  );

  const imageFragment = bodyCaptured.comment.find((b: any) => b.type === "image");
  assert.ok(imageFragment, "the edited comment must still contain an image fragment");
  assert.equal(imageFragment.image.url, ATTACHMENT_URL, "same attachment, not a new upload");
  assert.equal(imageFragment.image.name, "screenshot.png", "the displayed filename survives");

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
