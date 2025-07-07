import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { Buffer } from "buffer";
import { ImageMetadataBlock } from "./shared/types";

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
export async function processClickUpText(
  textItems: ClickUpTextItem[]
): Promise<(CallToolResult["content"][number] | ImageMetadataBlock)[]> {
  const contentBlocks: (CallToolResult["content"][number] | ImageMetadataBlock)[] = [];
  let currentTextBlock = "";

  for (let i = 0; i < textItems.length; i++) {
    const item = textItems[i];

    // Handle image items
    if (item.type === "image" && item.image && item.image.url) {
      // Add image URL reference inline to current text block
      const imageFileName = item.image.name || item.image.title || "image";
      currentTextBlock += `\nImage: ${imageFileName} - ${item.image.url}`;

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
          alt: item.text || imageFileName,
        });
      }
      // If no thumbnails, just treat as a file reference (already added to currentTextBlock)
    }
    // Handle text items
    else if (typeof item.text === "string") {
      currentTextBlock += item.text;
    }
    // Handle other types of items like bookmarks or whatever clickup can think of
    else {
      currentTextBlock += JSON.stringify(item);
    }
  }

  // Add any remaining text
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
export function processClickUpMarkdown(
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