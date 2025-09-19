import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processClickUpMarkdown, processClickUpText } from '../clickup-text';
import { ImageMetadataBlock } from '../shared/types';

const SAMPLE_DATA_URI = 'data:image/png;base64,QUJD';

function isTextBlock(block: any): block is { type: 'text'; text: string } {
  return block && block.type === 'text' && typeof block.text === 'string';
}

function isImageMetadataBlock(block: any): block is ImageMetadataBlock {
  return block && block.type === 'image_metadata';
}

test('processClickUpMarkdown strips inline data URIs from text output', async () => {
  const markdown = `Intro text.\n![](${SAMPLE_DATA_URI})\nOutro text.`;
  const blocks = processClickUpMarkdown(markdown, []);

  const textBlocks = blocks.filter(isTextBlock);
  assert.ok(textBlocks.length >= 1, 'Expected at least one text block');
  textBlocks.forEach(block => {
    assert.ok(!block.text.includes('data:image'), 'Text block should not include raw data URI');
  });
  assert.ok(
    textBlocks.some(block => block.text.includes('[inline image data]')),
    'At least one text block should mention inline image placeholder'
  );

  const imageMetadata = blocks.find(isImageMetadataBlock);
  assert.ok(imageMetadata, 'Expected an image_metadata block for inline data');
  assert.equal(imageMetadata.inlineData?.mimeType, 'image/png');
  assert.equal(imageMetadata.inlineData?.base64Data, 'QUJD');
});

test('processClickUpText handles inline data URIs without leaking base64 into text', async () => {
  const blocks = await processClickUpText([
    { text: 'Before image ' },
    {
      type: 'image',
      text: 'Screenshot',
      image: {
        url: SAMPLE_DATA_URI,
        name: 'Screenshot.png',
      },
    },
    { text: ' after image.' },
  ]);

  const textBlocks = blocks.filter(isTextBlock);
  assert.ok(textBlocks.length >= 1, 'Expected text output for inline image comments');
  textBlocks.forEach(block => {
    assert.ok(!block.text.includes('data:image'), 'Text block should not include raw data URI');
  });
  assert.ok(
    textBlocks.some(block => block.text.includes('[inline image data]')),
    'At least one text block should mention inline image placeholder'
  );

  const imageMetadata = blocks.find(isImageMetadataBlock);
  assert.ok(imageMetadata, 'Expected inline image to produce metadata block');
  assert.equal(imageMetadata.inlineData?.mimeType, 'image/png');
  assert.equal(imageMetadata.inlineData?.base64Data, 'QUJD');
});

test('downloadImages converts inline image metadata into image blocks', async () => {
  process.env.CLICKUP_API_KEY = process.env.CLICKUP_API_KEY || 'test-inline-key';
  process.env.CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID || 'test-inline-team';

  const { downloadImages } = await import('../shared/image-processing');

  const result = await downloadImages([
    {
      type: 'image_metadata',
      urls: [],
      alt: 'Inline image',
      inlineData: {
        mimeType: 'image/png',
        base64Data: 'QUJD',
      },
    },
  ]);

  const imageBlocks = result.filter(block => block.type === 'image');
  assert.equal(imageBlocks.length, 1, 'Expected inline data to become an image block');
  const imageBlock = imageBlocks[0] as { type: 'image'; data: string; mimeType: string };
  assert.equal(imageBlock.data, 'QUJD');
  assert.equal(imageBlock.mimeType, 'image/png');
});

test('downloadImages respects max image limit with inline data', async () => {
  process.env.CLICKUP_API_KEY = process.env.CLICKUP_API_KEY || 'test-inline-key';
  process.env.CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID || 'test-inline-team';

  const { downloadImages } = await import('../shared/image-processing');

  const result = await downloadImages([
    {
      type: 'image_metadata',
      urls: [],
      alt: 'Too old inline',
      inlineData: {
        mimeType: 'image/png',
        base64Data: 'AAA',
      },
    },
    {
      type: 'image_metadata',
      urls: [],
      alt: 'Recent inline',
      inlineData: {
        mimeType: 'image/png',
        base64Data: 'BBB',
      },
    },
  ], 1, 1);

  const imageBlocks = result.filter(block => block.type === 'image');
  assert.equal(imageBlocks.length, 1, 'Should keep only the most recent inline image');
  assert.equal((imageBlocks[0] as any).data, 'BBB');

  const removedPlaceholder = result.find(block => block.type === 'text' && block.text?.includes('Image removed due to count limitations'));
  assert.ok(removedPlaceholder, 'Older inline image should be replaced with placeholder text');
});
