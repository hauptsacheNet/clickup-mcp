import {ContentBlock, ImageMetadataBlock} from "./types";
import {CONFIG} from "./config";
import { Buffer } from "buffer";

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
      return await downloadSingleImage(block, perImageBudget);
    } else {
      return block as ContentBlock;
    }
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
  const fallbackText = {
    type: "text" as const,
    text: `[Image "${imageMetadata.alt}" removed due to size limitations.]`,
  };

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
        return {
          type: "image",
          mimeType: response.headers.get("Content-Type") || "image/png",
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