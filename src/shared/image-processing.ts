import {ContentBlock, ImageMetadataBlock} from "./types";
import {CONFIG} from "./config";
import { estimateBase64Size } from "./data-uri";
import { Buffer } from "buffer";

/**
 * Detect MIME type from image binary data using magic bytes (file signatures)
 * Returns null if the format is not recognized
 */
function detectMimeTypeFromBuffer(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 (‰PNG)
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return "image/jpeg";
  }

  // GIF: 47 49 46 38 (GIF8)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }

  // WebP: RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }

  return null;
}

/**
 * Detect MIME type from base64-encoded image data
 * Decodes just enough bytes to check magic numbers
 */
function detectMimeTypeFromBase64(base64Data: string): string | null {
  // Need at least 16 base64 chars to decode 12 bytes for magic number detection
  if (base64Data.length < 16) return null;

  // Create a Uint8Array directly from the decoded bytes to avoid Buffer pooling issues
  const header = Buffer.from(base64Data.slice(0, 16), "base64");
  const bytes = new Uint8Array(header);
  return detectMimeTypeFromBuffer(bytes.buffer);
}

/**
 * Downloads images from image_metadata blocks and applies smart size/count limiting
 * Prioritizes keeping the most recent images (assumes content is ordered with newest items last)
 * Uses intelligent size calculation accounting for text content
 *
 * @param content Array of content blocks that may contain image_metadata blocks
 * @param maxImages Maximum number of images to keep (defaults to CONFIG.maxImages)
 * @param maxSizeMB Maximum response size in MB (defaults to CONFIG.maxResponseSizeMB)
 * @returns Promise resolving to content array with downloaded images or placeholders
 */
export async function downloadImages(content: (ContentBlock | ImageMetadataBlock)[], maxImages: number = CONFIG.maxImages, maxSizeMB: number = CONFIG.maxResponseSizeMB): Promise<ContentBlock[]> {
  // First apply count-based limiting to image_metadata blocks
  const countLimitedContent = applyCountBasedLimitToImageMetadata(content, maxImages);
  
  // Calculate text size to determine available image budget
  const textContent = countLimitedContent.filter(block => block.type !== "image_metadata");
  const textSizeBytes = JSON.stringify(textContent).length;
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  const availableImageBudget = Math.max(0, maxSizeBytes - textSizeBytes);
  
  // Calculate per-image budget
  const imageMetadataBlocks = countLimitedContent.filter(block => block.type === "image_metadata") as ImageMetadataBlock[];
  const perImageBudget = imageMetadataBlocks.length > 0 ? availableImageBudget / imageMetadataBlocks.length : 0;
  
  // Download images in parallel and replace image_metadata blocks
  const downloadPromises = countLimitedContent.map(async (block) => {
    if (block.type === "image_metadata") {
      if (block.inlineData) {
        return convertInlineImage(block, perImageBudget);
      }
      return await downloadSingleImage(block, perImageBudget);
    }
    return block as ContentBlock;
  });
  
  return Promise.all(downloadPromises);
}

/**
 * Apply count-based limiting to image_metadata blocks
 * Keeps the most recent image_metadata blocks (newest last)
 */
function applyCountBasedLimitToImageMetadata(content: (ContentBlock | ImageMetadataBlock)[], maxImages: number): (ContentBlock | ImageMetadataBlock)[] {
  // Find all image_metadata block indices
  const imageMetadataIndices: number[] = [];
  content.forEach((block, index) => {
    if (block.type === "image_metadata") {
      imageMetadataIndices.push(index);
    }
  });

  // If we have fewer images than the limit, return the original content
  if (imageMetadataIndices.length <= maxImages) {
    return content;
  }

  // Determine which image_metadata blocks to remove (keep the most recent ones)
  const imagesToRemove = imageMetadataIndices.slice(0, imageMetadataIndices.length - maxImages);

  // Create a new content array with excess image_metadata blocks replaced by text placeholders
  return content.map((block, index) => {
    if (block.type === "image_metadata" && imagesToRemove.includes(index)) {
      return {
        type: "text" as const,
        text: "[Image removed due to count limitations. Only the most recent images are shown.]",
      };
    }
    return block;
  });
}

/**
 * Download a single image from an image_metadata block, trying different sizes if needed
 */
async function downloadSingleImage(imageMetadata: ImageMetadataBlock, perImageBudget: number): Promise<ContentBlock> {
  const fallbackText = createImageFallback(imageMetadata);

  // Try each URL in order (largest to smallest)
  for (const url of imageMetadata.urls) {
    const abortController = new AbortController();
    
    try {
      const response = await fetch(url, {
        signal: abortController.signal
      });
      
      if (!response.ok) {
        console.error(`Failed to fetch image from ${url}: ${response.status}`);
        continue;
      }

      // Check Content-Length header first to avoid downloading large images
      const contentLength = response.headers.get("Content-Length");
      if (contentLength) {
        const imageSizeBytes = parseInt(contentLength, 10);
        if (imageSizeBytes > perImageBudget) {
          // Cancel the request to stop any ongoing download
          abortController.abort();
          console.error(`Image from ${url} is ${imageSizeBytes} bytes (from Content-Length), exceeds budget of ${perImageBudget} bytes`);
          // Continue to try smaller thumbnail
          continue;
        }
      }

      const imageBuffer = await response.arrayBuffer();
      const actualSizeBytes = imageBuffer.byteLength;

      // Double-check actual size (in case Content-Length was missing or incorrect)
      if (actualSizeBytes <= perImageBudget) {
        // Detect actual MIME type from binary data, fall back to header or default
        const detectedMimeType = detectMimeTypeFromBuffer(imageBuffer);
        const mimeType = detectedMimeType || response.headers.get("Content-Type") || "image/png";

        return {
          type: "image",
          mimeType,
          data: Buffer.from(imageBuffer).toString("base64"),
        };
      } else {
        // Cancel to clean up the connection
        abortController.abort();
        console.error(`Image from ${url} is ${actualSizeBytes} bytes (actual size), exceeds budget of ${perImageBudget} bytes`);
        // Continue to try smaller thumbnail
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was cancelled, this is expected - continue to next URL
        continue;
      }
      console.error(`Error fetching image from ${url}: ${error.message || "Unknown error"}`);
      // Continue to try next URL
    }
  }

  // If all URLs failed or were too large, return fallback text
  return fallbackText;
}

/**
 * Create a fallback text block when an image cannot be included
 */
function createImageFallback(imageMetadata: ImageMetadataBlock): ContentBlock {
  return {
    type: "text" as const,
    text: `[Image "${imageMetadata.alt}" removed due to size limitations.]`,
  };
}

/**
 * Convert inline image data URIs into image blocks while respecting size budgets
 */
function convertInlineImage(imageMetadata: ImageMetadataBlock, perImageBudget: number): ContentBlock {
  const inlineData = imageMetadata.inlineData;
  if (!inlineData) {
    return createImageFallback(imageMetadata);
  }

  const estimatedSize = estimateBase64Size(inlineData.base64Data);

  if (perImageBudget <= 0 || estimatedSize > perImageBudget) {
    console.error(
      `Inline image for "${imageMetadata.alt}" is ${estimatedSize} bytes, exceeds budget of ${perImageBudget} bytes`
    );
    return createImageFallback(imageMetadata);
  }

  // Detect actual MIME type from binary data, fall back to declared type or default
  const detectedMimeType = detectMimeTypeFromBase64(inlineData.base64Data);
  const mimeType = detectedMimeType || inlineData.mimeType || "image/png";

  return {
    type: "image",
    mimeType,
    data: inlineData.base64Data,
  };
}
