import { CallToolResult } from "@modelcontextprotocol/sdk/types";

/**
 * Splits markdown text at image references and converts them to image blocks
 * @param markdownText The markdown text to process
 * @param attachmentMap Map of attachment URLs to their details
 * @returns Array of content blocks (text and images)
 */
export async function splitMarkdownAtImages(
  markdownText: string,
  attachmentMap: Map<string, any>,
): Promise<CallToolResult["content"]> {
  const contentBlocks: Promise<CallToolResult["content"][number]>[] = [];
  let currentTextBlock = "";

  // Regular expression to match markdown image syntax: ![alt text](url)
  const imageRegex = /!\[([^\]]*)\]\(([^\)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = imageRegex.exec(markdownText)) !== null) {
    const [fullMatch, altText, imageUrl] = match;

    // Add text before the image reference to the current text block
    currentTextBlock += markdownText.substring(lastIndex, match.index);

    // If we have accumulated text, add it as a text block
    if (currentTextBlock.trim()) {
      contentBlocks.push(
        Promise.resolve({
          type: "text",
          text: currentTextBlock.trim(),
        })
      );
    }

    // Reset current text block
    currentTextBlock = "";

    // Check if this image URL exists in our attachments
    const attachment = attachmentMap.get(imageUrl);
    if (attachment) {
      // Add this image as an image block
      contentBlocks.push(
        (async () => {
          try {
            const response = await fetch(
              attachment.thumbnail_medium || attachment.url
            );
            const imageBuffer = await response.arrayBuffer();
            return {
              type: "image",
              data: Buffer.from(imageBuffer).toString("base64"),
              mimeType: attachment.mimetype,
            };
          } catch (error: any) {
            console.error(
              `Error fetching image: ${error.message || "Unknown error"}`
            );
            return {
              type: "text",
              text: fullMatch,
            };
          }
        })()
      );
    } else {
      // If the image URL doesn't match any attachment, keep the original markdown
      currentTextBlock += fullMatch;
      console.error(`Image URL ${imageUrl} not found in attachments`, attachmentMap);
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
