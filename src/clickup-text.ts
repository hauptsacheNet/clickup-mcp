import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { Buffer } from "buffer";

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
  url: string;
  [key: string]: any;
}

/**
 * Process an array of ClickUp text items into a structured content format
 * that includes both text and images in their original sequence
 *
 * @param textItems Array of text items from ClickUp API
 * @returns Promise resolving to an array of content blocks (text and images)
 */
export async function processClickUpText(
  textItems: ClickUpTextItem[]
): Promise<CallToolResult["content"]> {
  const contentBlocks: Promise<CallToolResult["content"][number]>[] = [];
  let currentTextBlock = "";

  for (let i = 0; i < textItems.length; i++) {
    const item = textItems[i];

    // Handle image items
    if (item.type === "image" && item.image && item.image.thumbnail_large) {
      // If we have accumulated text, add it as a text block before adding the image
      if (currentTextBlock.trim()) {
        contentBlocks.push(
          Promise.resolve({
            type: "text" as const,
            text: currentTextBlock.trim(),
          })
        );
      }

      // Reset current text block after pushing it
      currentTextBlock = "";

      // Add this image as an image block
      if (typeof item.image.thumbnail_large === "string") {
        contentBlocks.push(
          loadImageContentBlock(item.image.thumbnail_large, {
            type: "text" as const,
            text: item.text || "Image",
          })
        );
      }
    }
    // Handle text items
    else if (item.text !== undefined) {
      currentTextBlock += item.text;
    }
  }

  // Add any remaining text
  if (currentTextBlock.trim()) {
    contentBlocks.push(
      Promise.resolve({
        type: "text" as const,
        text: currentTextBlock.trim(),
      })
    );
  }

  return Promise.all(contentBlocks);
}

/**
 * Splits markdown text at image references and converts them to image blocks
 * @param markdownText The markdown text to process
 * @param attachments Array of attachments from the Clickup API
 * @returns Array of content blocks (text and images)
 */
export async function processClickUpMarkdown(
  markdownText: string,
  attachments: ClickUpAttachment[]
): Promise<CallToolResult["content"]> {
  const contentBlocks: Promise<CallToolResult["content"][number]>[] = [];
  let currentTextBlock = "";

  // Create a map of attachment URLs to their thumbnail_large URLs for easy lookup
  const thumbnailMap = new Map<string, string>();
  for (const attachment of attachments) {
    if (typeof attachment.thumbnail_large === "string") {
      thumbnailMap.set(attachment.url, attachment.thumbnail_large);
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

    // Check if this image URL exists in our attachments
    const thumbnailUrl = thumbnailMap.get(imageUrl);
    if (thumbnailUrl) {
      // If we have accumulated text, add it as a text block before adding the image
      if (currentTextBlock.trim()) {
        contentBlocks.push(
          Promise.resolve({
            type: "text" as const,
            text: currentTextBlock.trim(),
          })
        );
      }

      // Reset current text block after pushing it
      currentTextBlock = "";

      // Add this image as an image block
      contentBlocks.push(
        loadImageContentBlock(thumbnailUrl, {
          type: "text" as const,
          text: fullMatch.trim(),
        })
      );
    } else {
      // If the image URL doesn't match any attachment, keep the original markdown in the current text block
      currentTextBlock += fullMatch;
      console.error(
        `Image URL ${imageUrl} not found in attachments`,
        thumbnailMap
      );
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Add any remaining text after the last image
  currentTextBlock += markdownText.substring(lastIndex);
  if (currentTextBlock.trim()) {
    contentBlocks.push(
      Promise.resolve({
        type: "text" as const,
        text: currentTextBlock.trim(),
      })
    );
  }

  return Promise.all(contentBlocks);
}

/**
 * Loads an image from a URL and converts it to a base64-encoded content block
 *
 * @param url URL of the image to load
 * @param fallback Fallback content if image loading fails
 * @returns Promise resolving to a content block (either image or fallback text)
 */
async function loadImageContentBlock(
  url: string,
  fallback: CallToolResult["content"][number]
): Promise<CallToolResult["content"][number]> {
  try {
    const response = await fetch(url);
    const imageBuffer = await response.arrayBuffer();
    return {
      type: "image",
      mimeType: response.headers.get("Content-Type") || "image/png",
      data: Buffer.from(imageBuffer).toString("base64"),
    };
  } catch (error: any) {
    console.error(`Error fetching image: ${error.message || "Unknown error"}`);
    return fallback;
  }
}