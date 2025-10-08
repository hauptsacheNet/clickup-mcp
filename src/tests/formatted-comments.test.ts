import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMarkdownToClickUpBlocks } from "../clickup-text";

test("convertMarkdownToClickUpBlocks handles headers", () => {
  const markdown = "# H1\n## H2\n### H3";
  const blocks = convertMarkdownToClickUpBlocks(markdown);

  // Find header blocks
  const h1 = blocks.find(b => b.attributes?.header === 1);
  const h2 = blocks.find(b => b.attributes?.header === 2);
  const h3 = blocks.find(b => b.attributes?.header === 3);

  assert.ok(h1, "should have H1 block");
  assert.ok(h2, "should have H2 block");
  assert.ok(h3, "should have H3 block");
});

test("convertMarkdownToClickUpBlocks handles blockquotes", () => {
  const markdown = "> This is a quote";
  const blocks = convertMarkdownToClickUpBlocks(markdown);

  const blockquote = blocks.find(b => b.attributes?.blockquote !== undefined);
  assert.ok(blockquote, "should have blockquote block");
});

test("convertMarkdownToClickUpBlocks handles lists", () => {
  const markdown = "- Item 1\n1. Item 2\n- [ ] Todo\n- [x] Done";
  const blocks = convertMarkdownToClickUpBlocks(markdown);

  const bullet = blocks.find(b => b.attributes?.list?.list === 'bullet');
  const ordered = blocks.find(b => b.attributes?.list?.list === 'ordered');
  const unchecked = blocks.find(b => b.attributes?.list?.list === 'unchecked');
  const checked = blocks.find(b => b.attributes?.list?.list === 'checked');

  assert.ok(bullet, "should have bullet list");
  assert.ok(ordered, "should have ordered list");
  assert.ok(unchecked, "should have unchecked checkbox");
  assert.ok(checked, "should have checked checkbox");
});

test("convertMarkdownToClickUpBlocks handles code blocks", () => {
  const markdown = "```\ncode here\n```";
  const blocks = convertMarkdownToClickUpBlocks(markdown);

  const codeBlock = blocks.find(b => b.attributes?.['code-block'] !== undefined);
  assert.ok(codeBlock, "should have code block");
});

test("convertMarkdownToClickUpBlocks handles inline formatting", () => {
  const markdown = "**bold** *italic* `code` [link](https://example.com)";
  const blocks = convertMarkdownToClickUpBlocks(markdown);

  const bold = blocks.find(b => b.attributes?.bold === true);
  const italic = blocks.find(b => b.attributes?.italic === true);
  const code = blocks.find(b => b.attributes?.code === true);
  const link = blocks.find(b => b.attributes?.link === 'https://example.com');

  assert.ok(bold, "should have bold");
  assert.ok(italic, "should have italic");
  assert.ok(code, "should have code");
  assert.ok(link, "should have link");
});

test("convertMarkdownToClickUpBlocks comprehensive test", () => {
  const markdown = `# Heading 1

This has **bold** and *italic*.

> A quote

- List item
- [x] Done

\`\`\`
code
\`\`\``;

  const blocks = convertMarkdownToClickUpBlocks(markdown);

  // Should have all formatting types
  assert.ok(blocks.find(b => b.attributes?.header === 1), "has header");
  assert.ok(blocks.find(b => b.attributes?.bold === true), "has bold");
  assert.ok(blocks.find(b => b.attributes?.italic === true), "has italic");
  assert.ok(blocks.find(b => b.attributes?.blockquote !== undefined), "has blockquote");
  assert.ok(blocks.find(b => b.attributes?.list?.list === 'bullet'), "has bullet list");
  assert.ok(blocks.find(b => b.attributes?.list?.list === 'checked'), "has checkbox");
  assert.ok(blocks.find(b => b.attributes?.['code-block'] !== undefined), "has code block");
});

test("convertMarkdownToClickUpBlocks handles nested bold+italic", () => {
  const markdown = "Text with ***bold and italic*** together";
  const blocks = convertMarkdownToClickUpBlocks(markdown);

  const nested = blocks.find(b => b.attributes?.bold && b.attributes?.italic);
  assert.ok(nested, "should have block with both bold and italic");
  assert.equal(nested?.text, "bold and italic");
});

test("convertMarkdownToClickUpBlocks handles nested lists with indent", () => {
  const markdown = `- Top level
  - Second level
    - Third level
  - Back to second
- Another top`;

  const blocks = convertMarkdownToClickUpBlocks(markdown);

  // Find blocks with different indent levels
  const topLevel = blocks.filter(b => b.attributes?.list && !b.attributes?.indent);
  const secondLevel = blocks.filter(b => b.attributes?.list && b.attributes?.indent === 1);
  const thirdLevel = blocks.filter(b => b.attributes?.list && b.attributes?.indent === 2);

  assert.equal(topLevel.length, 2, "should have 2 top level items");
  assert.equal(secondLevel.length, 2, "should have 2 second level items");
  assert.equal(thirdLevel.length, 1, "should have 1 third level item");
});

test("convertMarkdownToClickUpBlocks handles nested numbered lists", () => {
  const markdown = `1. First
   1. Nested first
   2. Nested second
2. Second`;

  const blocks = convertMarkdownToClickUpBlocks(markdown);

  const topLevel = blocks.filter(b => b.attributes?.list?.list === 'ordered' && !b.attributes?.indent);
  const nested = blocks.filter(b => b.attributes?.list?.list === 'ordered' && b.attributes?.indent === 1);

  assert.equal(topLevel.length, 2, "should have 2 top level numbered items");
  assert.equal(nested.length, 2, "should have 2 nested numbered items");
});

test("convertMarkdownToClickUpBlocks handles mixed nested lists", () => {
  const markdown = `- Bullet
  1. Nested number
    - Deep bullet`;

  const blocks = convertMarkdownToClickUpBlocks(markdown);

  const bullet = blocks.find(b => b.attributes?.list?.list === 'bullet' && !b.attributes?.indent);
  const nestedNumber = blocks.find(b => b.attributes?.list?.list === 'ordered' && b.attributes?.indent === 1);
  // Mixed list types: the bullet inside the numbered list is at indent 1 (relative to its parent)
  const deepBullet = blocks.find(b => b.attributes?.list?.list === 'bullet' && b.attributes?.indent === 1 && b.text === "\n");

  assert.ok(bullet, "should have top level bullet");
  assert.ok(nestedNumber, "should have nested numbered item");
  assert.ok(deepBullet, "should have nested bullet inside numbered list");
});
