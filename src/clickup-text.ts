import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { Buffer } from "buffer";
import { ImageMetadataBlock } from "./shared/types";
import { parseDataUri } from "./shared/data-uri";
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, PhrasingContent, Link, Text, Content, Heading, Paragraph, Blockquote, List, ListItem, Code } from 'mdast';

/**
 * Represents a ClickUp text item which can be plain text or an image
 */
export interface ClickUpTextItem {
  text?: string;
  type?: string;
  image?: {
    id?: string;
    name?: string;
    title?: string;
    type?: string;
    extension?: string;
    thumbnail_large?: string;
    thumbnail_medium?: string;
    thumbnail_small?: string;
    url: string;
    uploaded?: boolean;
  };
  attributes?: any;
}

/**
 * Represents a ClickUp attachment
 */
export interface ClickUpAttachment {
  thumbnail_large?: string;
  thumbnail_medium?: string;
  thumbnail_small?: string;
  url: string;
  [key: string]: any;
}

/**
 * Extract thumbnail URLs from data-attachment attribute JSON
 * ClickUp API sometimes has broken thumbnail URLs, but data-attachment contains working ones
 */
function extractThumbnailsFromDataAttachment(attributes?: any): {
  thumbnail_large?: string;
  thumbnail_medium?: string;
  thumbnail_small?: string;
} {
  if (!attributes || !attributes['data-attachment']) {
    return {};
  }

  try {
    const attachmentData = JSON.parse(attributes['data-attachment']);
    return {
      thumbnail_large: attachmentData.thumbnail_large,
      thumbnail_medium: attachmentData.thumbnail_medium,
      thumbnail_small: attachmentData.thumbnail_small,
    };
  } catch (error) {
    console.error('Error parsing data-attachment:', error);
    return {};
  }
}

/**
 * Process an array of ClickUp text items into a structured content format
 * that includes both text and images in their original sequence
 *
 * @param textItems Array of text items from ClickUp API
 * @returns Promise resolving to an array of content blocks (text and images)
 */
export async function convertClickUpTextItemsToToolCallResult(
  textItems: ClickUpTextItem[]
): Promise<(CallToolResult["content"][number] | ImageMetadataBlock)[]> {
  const contentBlocks: (CallToolResult["content"][number] | ImageMetadataBlock)[] = [];
  let currentTextBlock = "";
  let currentLine = ""; // Track current line separately for block formatting

  // Track current formatting state to avoid unnecessary close/reopen
  let activeBold = false;
  let activeItalic = false;
  let activeCode = false;

  for (let i = 0; i < textItems.length; i++) {
    const item = textItems[i];

    // Handle image items
    if (item.type === "image" && item.image && item.image.url) {
      const imageFileName = item.image.name || item.image.title || "image";
      const imageUrl = item.image.url;
      const altText = item.text || imageFileName;

      if (imageUrl.startsWith("data:")) {
        const parsedData = parseDataUri(imageUrl);
        currentTextBlock += `\nImage: ${imageFileName} - [inline image data]`;

        if (currentTextBlock.trim()) {
          contentBlocks.push({
            type: "text" as const,
            text: currentTextBlock.trim(),
          });
        }

        currentTextBlock = "";

        if (parsedData) {
          contentBlocks.push({
            type: "image_metadata",
            urls: [],
            alt: altText,
            inlineData: parsedData,
          });
        } else {
          console.error(`Unable to parse inline image data for ${imageFileName}`);
          contentBlocks.push({
            type: "text" as const,
            text: `[Image "${altText}" omitted: unsupported inline data URI]`,
          });
        }
        continue;
      }

      // Add image URL reference inline to current text block
      currentTextBlock += `\nImage: ${imageFileName} - ${imageUrl}`;

      // Get working thumbnail URLs from data-attachment if available
      const extractedThumbnails = extractThumbnailsFromDataAttachment(item.attributes);
      
      // Determine best thumbnail URLs (prefer extracted over API thumbnails)
      const thumbnail_large = extractedThumbnails.thumbnail_large || item.image.thumbnail_large;
      const thumbnail_medium = extractedThumbnails.thumbnail_medium || item.image.thumbnail_medium;
      const thumbnail_small = extractedThumbnails.thumbnail_small || item.image.thumbnail_small;

      // Only create image_metadata if we have at least one thumbnail (never use original image)
      if (thumbnail_large || thumbnail_medium || thumbnail_small) {
        // Push accumulated text (including image URL) as a text block
        if (currentTextBlock.trim()) {
          contentBlocks.push({
            type: "text" as const,
            text: currentTextBlock.trim(),
          });
        }

        // Reset current text block after pushing it
        currentTextBlock = "";

        // Create URLs array with largest to smallest preference, filter out undefined
        const urls = [thumbnail_large, thumbnail_medium, thumbnail_small].filter(Boolean) as string[];

        // Add image_metadata block for lazy loading
        contentBlocks.push({
          type: "image_metadata",
          urls: urls,
          alt: altText,
        });
      }
      // If no thumbnails, just treat as a file reference (already added to currentTextBlock)
    }
    // Handle text items
    else if (typeof item.text === "string") {
      // Check if this is a newline with block formatting (header, blockquote, list)
      if (item.text === '\n' && item.attributes) {
        // Header formatting
        if (item.attributes.header) {
          const level = item.attributes.header;
          currentLine = '#'.repeat(level) + ' ' + currentLine;
        }
        // Blockquote formatting
        else if (item.attributes.blockquote) {
          currentLine = '> ' + currentLine;
        }
        // List formatting
        else if (item.attributes.list) {
          const listType = item.attributes.list.list;
          const indent = item.attributes.indent || 0;
          // Add indentation (2 spaces per level) for nested lists
          const indentStr = '  '.repeat(indent);

          switch (listType) {
            case 'bullet':
              currentLine = indentStr + '- ' + currentLine;
              break;
            case 'ordered':
              currentLine = indentStr + '1. ' + currentLine;
              break;
            case 'checked':
              currentLine = indentStr + '- [x] ' + currentLine;
              break;
            case 'unchecked':
              currentLine = indentStr + '- [ ] ' + currentLine;
              break;
          }
        }
        // Code block formatting
        else if (item.attributes['code-block']) {
          // Wrap the current line in code block markers
          currentLine = '```\n' + currentLine + '\n```';
        }

        // Add formatted line to text block
        currentTextBlock += currentLine;
        // Add newline unless it's code block (already has newlines)
        if (!item.attributes['code-block']) {
          currentTextBlock += '\n';
        }
        currentLine = ""; // Reset for next line
        continue;
      }

      // Regular text with inline formatting
      let formattedText = item.text;

      // Determine current and next formatting state
      const hasBold = item.attributes?.bold === true;
      const hasItalic = item.attributes?.italic === true;
      const hasLink = item.attributes?.link;

      // Look ahead to next non-newline block
      let nextHasBold = false;
      let nextHasItalic = false;
      for (let j = i + 1; j < textItems.length; j++) {
        const nextItem = textItems[j];
        if (nextItem.text !== '\n' || !nextItem.attributes) {
          nextHasBold = nextItem.attributes?.bold === true;
          nextHasItalic = nextItem.attributes?.italic === true;
          break;
        }
      }

      // Build prefix (open new formatting)
      let prefix = "";
      if (hasBold && !activeBold) prefix += "**";
      if (hasItalic && !activeItalic) prefix += "*";

      // Build suffix (close formatting that won't continue)
      let suffix = "";
      if (hasItalic && !nextHasItalic) suffix += "*";
      if (hasBold && !nextHasBold) suffix += "**";

      // Close formatting that's active but not in this block
      let closingPrefix = "";
      if (activeBold && !hasBold) closingPrefix += "**";
      if (activeItalic && !hasItalic) closingPrefix += "*";

      formattedText = closingPrefix + prefix + formattedText + suffix;

      // Update state
      activeBold = hasBold && nextHasBold;
      activeItalic = hasItalic && nextHasItalic;

      // Link formatting (wraps everything)
      if (hasLink) {
        formattedText = `[${formattedText}](${hasLink})`;
      }

      // Code formatting
      if (item.attributes?.code) {
        formattedText = `\`${formattedText}\``;
      }

      // Add to current line (not text block yet)
      if (item.text === '\n') {
        // Plain newline without formatting
        currentTextBlock += currentLine + '\n';
        currentLine = "";
      } else {
        currentLine += formattedText;
      }
    }
    // Handle other types of items like bookmarks or whatever clickup can think of
    else {
      currentTextBlock += JSON.stringify(item);
    }
  }

  // Add any remaining text
  if (currentLine) {
    currentTextBlock += currentLine;
  }
  if (currentTextBlock.trim()) {
    contentBlocks.push({
      type: "text" as const,
      text: currentTextBlock.trim(),
    });
  }

  return contentBlocks;
}

/**
 * Splits markdown text at image references and converts them to image blocks
 * @param markdownText The markdown text to process
 * @param attachments Array of attachments from the Clickup API
 * @returns Array of content blocks (text and images)
 */
export function convertMarkdownToToolCallResult(
  markdownText: string,
  attachments: ClickUpAttachment[] | null | undefined
): (CallToolResult["content"][number] | ImageMetadataBlock)[] {
  const contentBlocks: (CallToolResult["content"][number] | ImageMetadataBlock)[] = [];
  let currentTextBlock = "";

  // Create a map of attachment URLs to their full info for easy lookup
  const attachmentMap = new Map<string, ClickUpAttachment>();
  if (attachments && Array.isArray(attachments)) {
    for (const attachment of attachments) {
      attachmentMap.set(attachment.url, attachment);
    }
  }

  // Regular expression to match markdown image syntax: ![alt text](url)
  const imageRegex = /!\[([^\]]*)\]\(([^\)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = imageRegex.exec(markdownText)) !== null) {
    const [fullMatch, altText, imageUrl] = match;

    // Add text before the image reference to the current text block
    currentTextBlock += markdownText.substring(lastIndex, match.index);

    if (imageUrl.startsWith("data:")) {
      const imageFileName = altText || "image";
      const parsedData = parseDataUri(imageUrl);
      currentTextBlock += `\nImage: ${imageFileName} - [inline image data]`;

      if (currentTextBlock.trim()) {
        contentBlocks.push({
          type: "text" as const,
          text: currentTextBlock.trim(),
        });
      }

      currentTextBlock = "";

      if (parsedData) {
        contentBlocks.push({
          type: "image_metadata",
          urls: [],
          alt: altText || imageFileName,
          inlineData: parsedData,
        });
      } else {
        console.error(`Unable to parse inline image data for ${imageFileName}`);
        contentBlocks.push({
          type: "text" as const,
          text: `[Image "${altText || imageFileName}" omitted: unsupported inline data URI]`,
        });
      }

      lastIndex = match.index + fullMatch.length;
      continue;
    }

    // Check if this image URL exists in our attachments
    const attachment = attachmentMap.get(imageUrl);
    if (attachment) {
      // Add image URL reference inline to current text block
      const imageFileName = altText || "image";
      currentTextBlock += `\nImage: ${imageFileName} - ${imageUrl}`;

      // Only create image_metadata if we have at least one thumbnail (never use original image)
      if (attachment.thumbnail_large || attachment.thumbnail_medium || attachment.thumbnail_small) {
        // Push accumulated text (including image URL) as a text block
        if (currentTextBlock.trim()) {
          contentBlocks.push({
            type: "text" as const,
            text: currentTextBlock.trim(),
          });
        }

        // Reset current text block after pushing it
        currentTextBlock = "";

        // Create URLs array with largest to smallest preference, filter out undefined
        const urls = [attachment.thumbnail_large, attachment.thumbnail_medium, attachment.thumbnail_small].filter(Boolean) as string[];

        // Add image_metadata block for lazy loading
        contentBlocks.push({
          type: "image_metadata",
          urls: urls,
          alt: altText || imageFileName,
        });
      }
      // If no thumbnails, just treat as a file reference (already added to currentTextBlock)
    } else {
      // If the image URL doesn't match any attachment, keep the original markdown in the current text block
      currentTextBlock += fullMatch;
      console.error(
        `Image URL ${imageUrl} not found in attachments`,
        attachmentMap
      );
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Add any remaining text after the last image
  currentTextBlock += markdownText.substring(lastIndex);

  // Process non-image attachments that weren't referenced in markdown
  const referencedUrls = new Set<string>();
  const imageMatches = markdownText.matchAll(/!\[([^\]]*)\]\(([^\)]+)\)/g);
  for (const match of imageMatches) {
    referencedUrls.add(match[2]);
  }

  // Add non-image files inline to the current text block
  if (attachments && Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!referencedUrls.has(attachment.url)) {
        // Determine if this is an image based on URL or type
        const isImage = attachment.thumbnail_large || 
          /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(attachment.url);
        
        if (!isImage) {
          // This is a non-image file - add inline to current text block
          const fileName = extractFileNameFromUrl(attachment.url) || "file";
          const fileType = extractFileTypeFromUrl(attachment.url);
          const fileTypeText = fileType ? ` (${fileType.toUpperCase()})` : "";
          
          currentTextBlock += `\nFile: ${fileName}${fileTypeText} - ${attachment.url}`;
        }
      }
    }
  }

  // Add any remaining text (including file references) as final text block
  if (currentTextBlock.trim()) {
    contentBlocks.push({
      type: "text" as const,
      text: currentTextBlock.trim(),
    });
  }

  return contentBlocks;
}


/**
 * Extract filename from URL
 */
function extractFileNameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop();
    return filename && filename !== '' ? filename : null;
  } catch {
    return null;
  }
}

/**
 * Extract file extension from URL
 */
function extractFileTypeFromUrl(url: string): string | null {
  const filename = extractFileNameFromUrl(url);
  if (!filename) return null;

  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return null;

  return filename.substring(lastDot + 1);
}

/**
 * Represents a ClickUp comment block with formatting
 */
export interface ClickUpCommentBlock {
  text?: string;
  type?: string;
  attributes?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    link?: string;
    'code-block'?: {
      'code-block': string;
    };
    header?: number; // 1-6 for h1-h6
    blockquote?: {};
    'blockquote-size'?: 'large';
    list?: {
      list: 'bullet' | 'ordered' | 'unchecked' | 'checked';
    };
    indent?: number; // Nesting level for lists (1 = first level nest, 2 = second, etc.)
    'block-id'?: string;
  };
  list?: {
    list: 'bullet' | 'ordered' | 'unchecked' | 'checked';
  };
}

/**
 * Convert markdown text to ClickUp comment blocks format using remark
 * Supports: headers, bold, italic, code, links, lists, blockquotes, code blocks
 *
 * @param markdown The markdown text to convert
 * @returns Array of ClickUp comment blocks
 */
export function convertMarkdownToClickUpBlocks(markdown: string): ClickUpCommentBlock[] {
  const blocks: ClickUpCommentBlock[] = [];

  try {
    // Parse the entire markdown document using remark with GFM support (for task lists)
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(markdown) as Root;

    // Walk the tree recursively
    walkMdastNodes(tree.children, {}, blocks);

  } catch (error) {
    console.error('Failed to parse markdown:', error);
    // Fallback to plain text
    return [{ text: markdown, attributes: {} }];
  }

  return blocks;
}

/**
 * Recursively walk mdast nodes and convert to ClickUp blocks
 * @param nodes Array of mdast nodes to process
 * @param inheritedAttrs Formatting attributes inherited from parent nodes
 * @param blocks Output array to append ClickUp blocks to
 * @param depth Nesting depth for lists (0 = top level, 1 = first nest, etc.)
 */
function walkMdastNodes(
  nodes: Content[],
  inheritedAttrs: ClickUpCommentBlock['attributes'],
  blocks: ClickUpCommentBlock[],
  depth: number = 0
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const currentAttrs = { ...inheritedAttrs };

    switch (node.type) {
      case 'heading':
        // Process heading content with inline formatting
        walkPhrasingContent((node as Heading).children, currentAttrs, blocks);
        // Add newline with header attribute
        blocks.push({ text: '\n', attributes: { header: (node as Heading).depth } });
        break;

      case 'paragraph':
        // Process paragraph content with inline formatting
        walkPhrasingContent((node as Paragraph).children, currentAttrs, blocks);
        // Add newline unless it's the last node
        if (i < nodes.length - 1) {
          blocks.push({ text: '\n', attributes: {} });
        }
        break;

      case 'blockquote':
        // ClickUp limitation: Blockquotes only support paragraph content, not headers or lists
        // For complex blockquote content (headers, lists), only paragraph text is preserved
        const blockquoteChildren = (node as Blockquote).children;
        for (const child of blockquoteChildren) {
          if (child.type === 'paragraph') {
            walkPhrasingContent((child as Paragraph).children, currentAttrs, blocks);
            blocks.push({ text: '\n', attributes: { blockquote: {} } });
          }
          // Note: Other child types (heading, list) are not supported by ClickUp blockquotes
          // and will be silently skipped, preserving only inline paragraph content
        }
        break;

      case 'list':
        const listNode = node as List;
        const listType = listNode.ordered ? 'ordered' : 'bullet';

        for (const item of listNode.children) {
          const listItem = item as ListItem;

          // Check if it's a checkbox item
          const isChecked = listItem.checked === true;
          const isUnchecked = listItem.checked === false;
          const finalListType = isChecked ? 'checked' : isUnchecked ? 'unchecked' : listType;

          // Process list item content
          for (const itemChild of listItem.children) {
            if (itemChild.type === 'paragraph') {
              // Process paragraph content with inline formatting
              walkPhrasingContent((itemChild as Paragraph).children, currentAttrs, blocks);

              // Add newline with list formatting and optional indent
              const listAttrs: ClickUpCommentBlock['attributes'] = {
                list: { list: finalListType }
              };

              // Add indent for nested lists (depth 0 = no indent, depth 1+ = indented)
              if (depth > 0) {
                listAttrs.indent = depth;
              }

              blocks.push({ text: '\n', attributes: listAttrs });
            } else if (itemChild.type === 'list') {
              // Nested list - recursively process with increased depth
              walkMdastNodes([itemChild], currentAttrs, blocks, depth + 1);
            }
          }
        }
        break;

      case 'code':
        // Code block
        const codeNode = node as Code;
        if (codeNode.value) {
          blocks.push({ text: codeNode.value, attributes: {} });
          blocks.push({
            text: '\n',
            attributes: { 'code-block': { 'code-block': codeNode.lang || 'plain' } }
          });
        }
        break;

      case 'thematicBreak':
        // Horizontal rule - just add a line break
        blocks.push({ text: '\n', attributes: {} });
        break;

      default:
        // For any other block-level nodes, try to process children
        if ('children' in node && Array.isArray(node.children)) {
          walkMdastNodes(node.children as Content[], currentAttrs, blocks, depth);
        }
        break;
    }
  }
}

/**
 * Recursively walk phrasing content (inline nodes) and build ClickUp blocks
 * Accumulates formatting attributes from parent nodes
 */
function walkPhrasingContent(
  nodes: PhrasingContent[],
  inheritedAttrs: ClickUpCommentBlock['attributes'],
  blocks: ClickUpCommentBlock[]
): void {
  for (const node of nodes) {
    const currentAttrs = { ...inheritedAttrs };

    switch (node.type) {
      case 'text':
        // Plain text node
        if (node.value) {
          blocks.push({
            text: node.value,
            attributes: Object.keys(currentAttrs).length > 0 ? currentAttrs : {}
          });
        }
        break;

      case 'strong':
        // Bold text - recurse with bold attribute
        currentAttrs.bold = true;
        walkPhrasingContent(node.children, currentAttrs, blocks);
        break;

      case 'emphasis':
        // Italic text - recurse with italic attribute
        currentAttrs.italic = true;
        walkPhrasingContent(node.children, currentAttrs, blocks);
        break;

      case 'inlineCode':
        // Inline code
        if (node.value) {
          currentAttrs.code = true;
          blocks.push({
            text: node.value,
            attributes: currentAttrs
          });
        }
        break;

      case 'link':
        // Link - recurse with link attribute
        currentAttrs.link = node.url;
        walkPhrasingContent(node.children, currentAttrs, blocks);
        break;

      case 'break':
        // Line break - add as plain text
        blocks.push({ text: '\n', attributes: {} });
        break;

      default:
        // For any other node types, try to extract text if available
        if ('value' in node && typeof node.value === 'string') {
          blocks.push({
            text: node.value,
            attributes: Object.keys(currentAttrs).length > 0 ? currentAttrs : {}
          });
        } else if ('children' in node && Array.isArray(node.children)) {
          // Recurse into children for other container nodes
          walkPhrasingContent(node.children as PhrasingContent[], currentAttrs, blocks);
        }
        break;
    }
  }
}
