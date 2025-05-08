import { CallToolResult } from "@modelcontextprotocol/sdk/types";

/**
 * Splits markdown text at image references and converts them to image blocks
 * @param markdownText The markdown text to process
 * @param attachments Array of attachments from the Clickup API
 * @returns Array of content blocks (text and images)
 */
export async function splitMarkdownAtImages(
  markdownText: string,
  attachments: { thumbnail_large?: any; url: string }[]
): Promise<CallToolResult["content"]> {
  const contentBlocks: Promise<CallToolResult["content"][number]>[] = [];
  let currentTextBlock = "";

  // Create a map of attachment URLs to their details for easy lookup
  const attachmentMap = new Map<string, (typeof attachments)[number]>();
  for (const attachment of attachments) {
    if (typeof attachment.thumbnail_large === "string") {
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
      // If we have accumulated text, add it as a text block before adding the image
      if (currentTextBlock.trim()) {
        contentBlocks.push(
          Promise.resolve({
            type: "text",
            text: currentTextBlock.trim(),
          })
        );
      }

      // Reset current text block after pushing it
      currentTextBlock = "";

      // Add this image as an image block
      contentBlocks.push(
        loadImageContentBlock(attachment.thumbnail_large, {
          type: "text",
          text: fullMatch.trim(),
        })
      );
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
  if (currentTextBlock.trim()) {
    contentBlocks.push(
      Promise.resolve({
        type: "text",
        text: currentTextBlock.trim(),
      })
    );
  }

  return Promise.all(contentBlocks);
}

async function loadImageContentBlock(
  url: string,
  fallback: CallToolResult["content"][number]
): Promise<CallToolResult["content"][number]> {
  try {
    const response = await fetch(url);
    const imageBuffer = await response.arrayBuffer();
    return {
      type: "image",
      data: Buffer.from(imageBuffer).toString("base64"),
      mimeType: response.headers.get("Content-Type") || "image/png",
    };
  } catch (error: any) {
    console.error(`Error fetching image: ${error.message || "Unknown error"}`);
    return fallback;
  }
}
