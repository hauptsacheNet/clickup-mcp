import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertMarkdownToClickUpBlocks,
  convertClickUpTextItemsToToolCallResult,
  parseClickUpTaskUrl,
} from "../clickup-text";

test("parseClickUpTaskUrl accepts plain task URLs and rejects everything else", () => {
  assert.equal(parseClickUpTaskUrl("https://app.clickup.com/t/86cb3t6t2"), "86cb3t6t2");
  assert.equal(parseClickUpTaskUrl("https://app.clickup.com/t/4500611/86cb3t6t2"), "86cb3t6t2");
  assert.equal(parseClickUpTaskUrl("https://app.clickup.com/t/86cb3t6t2/"), "86cb3t6t2");

  // Deep links, custom IDs and non-task URLs must stay ordinary links
  assert.equal(parseClickUpTaskUrl("https://app.clickup.com/t/86cb3t6t2?comment=123"), null);
  assert.equal(parseClickUpTaskUrl("https://app.clickup.com/t/4500611/ABC-123"), null);
  assert.equal(parseClickUpTaskUrl("https://app.clickup.com/4500611/v/li/901510208916"), null);
  assert.equal(parseClickUpTaskUrl("https://example.com/t/86cb3t6t2"), null);
});

test("a bare task URL in a comment becomes a task mention fragment", () => {
  const blocks = convertMarkdownToClickUpBlocks(
    "Siehe https://app.clickup.com/t/86cb3t6t2 dazu."
  );

  const mention = blocks.find((b) => b.type === "task_mention");
  assert.ok(mention, `expected a task_mention fragment, got: ${JSON.stringify(blocks)}`);
  assert.deepEqual(mention!.task_mention, { task_id: "86cb3t6t2" });

  // The surrounding text survives
  const text = blocks.map((b) => b.text ?? "").join("");
  assert.ok(text.includes("Siehe "));
  assert.ok(text.includes(" dazu."));
});

test("a markdown link to a task becomes a mention, dropping the custom text", () => {
  const blocks = convertMarkdownToClickUpBlocks(
    "Behoben mit [diesem Ticket](https://app.clickup.com/t/86cb3t6t2)."
  );

  const mention = blocks.find((b) => b.type === "task_mention");
  assert.ok(mention, `expected a task_mention fragment, got: ${JSON.stringify(blocks)}`);
  assert.deepEqual(mention!.task_mention, { task_id: "86cb3t6t2" });

  const text = blocks.map((b) => b.text ?? "").join("");
  assert.ok(!text.includes("diesem Ticket"), "the custom link text is replaced by the live reference");
});

test("task URLs with a query string stay ordinary links", () => {
  const blocks = convertMarkdownToClickUpBlocks(
    "Siehe [Kommentar](https://app.clickup.com/t/86cb3t6t2?comment=90150001)."
  );

  assert.ok(!blocks.some((b) => b.type === "task_mention"));
  const link = blocks.find((b) => b.attributes?.link);
  assert.ok(link, "the deep link must survive as a link");
  assert.equal(link!.attributes!.link, "https://app.clickup.com/t/86cb3t6t2?comment=90150001");
  assert.equal(link!.text, "Kommentar");
});

test("a mention inside a list item keeps the list formatting", () => {
  const blocks = convertMarkdownToClickUpBlocks(
    "- Blockiert durch https://app.clickup.com/t/86cb3t6t2"
  );

  const mentionIndex = blocks.findIndex((b) => b.type === "task_mention");
  assert.ok(mentionIndex >= 0);
  const newline = blocks[mentionIndex + 1];
  assert.equal(newline?.text, "\n");
  assert.deepEqual(newline?.attributes?.list, { list: "bullet" });
});

test("reading a task mention yields the task URL, and writing it back regenerates the mention", async () => {
  const contentBlocks = await convertClickUpTextItemsToToolCallResult([
    { text: "Das ist mit der Umsetzung von " },
    { type: "task_mention", task_mention: { task_id: "86cb3t6t2" } },
    { text: " behoben.\n" },
  ]);

  const readBack = contentBlocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  assert.ok(
    readBack.includes("https://app.clickup.com/t/86cb3t6t2"),
    `the mention must be readable as a URL, got: ${readBack}`
  );

  // Round trip: handing the read-back text to the write converter restores the mention
  const rewritten = convertMarkdownToClickUpBlocks(readBack);
  const mention = rewritten.find((b) => b.type === "task_mention");
  assert.ok(mention, `expected the mention to be regenerated, got: ${JSON.stringify(rewritten)}`);
  assert.deepEqual(mention!.task_mention, { task_id: "86cb3t6t2" });
});
