import { ContentBlock } from "./types";
import { CONFIG } from "./config";

/**
 * Checks if a string looks like a valid ClickUp task ID
 * Valid task IDs are 6-9 characters long and contain only alphanumeric characters
 */
export function isTaskId(str: string): boolean {
  // Task IDs are 6-9 characters long and contain only alphanumeric characters
  return /^[a-z0-9]{6,9}$/i.test(str);
}

/**
 * Limits the number of images in the content array, replacing excess images with text placeholders
 * Prioritizes keeping the most recent images (assumes content is ordered with newest items last)
 * 
 * @param content Array of content blocks that may contain images
 * @param maxImages Maximum number of images to keep
 * @returns Modified content array with limited images
 */
export function limitImages(content: ContentBlock[], maxImages: number): ContentBlock[] {
  // Count how many images we have
  const imageIndices: number[] = [];

  // Find all image blocks
  content.forEach((block, index) => {
    if (block.type === "image") {
      imageIndices.push(index);
    }
  });

  // If we have fewer images than the limit, return the original content
  if (imageIndices.length <= maxImages) {
    return content;
  }

  // Determine which images to keep (the most recent ones)
  // We want to keep the last 'maxImages' images
  const imagesToRemove = imageIndices.slice(0, imageIndices.length - maxImages);

  // Create a new content array with excess images replaced by text
  return content.map((block, index) => {
    if (block.type === "image" && imagesToRemove.includes(index)) {
      return {
        type: "text" as const,
        text: "[Image removed due to size limitations. Only the most recent images are shown.]",
      };
    }
    return block;
  });
}

const spaceCache = new Map<string, Promise<any>>(); // Global cache for space details promises

/**
 * Function to get space details, using a cache to avoid redundant fetches
 */
export async function getSpaceDetails(spaceId: string): Promise<any> {
  if (!spaceId) {
    return null;
  }
  if (!spaceCache.has(spaceId)) {
    const fetchPromise = fetch(`https://api.clickup.com/api/v2/space/${spaceId}`, {
      headers: { Authorization: CONFIG.apiKey },
    })
    .then(res => {
      if (!res.ok) {
        // Don't cache failed requests, or handle errors more gracefully
        console.error(`Error fetching space ${spaceId}: ${res.status}`);
        spaceCache.delete(spaceId); // Allow retry on next call
        return null;
      }
      return res.json();
    })
    .catch(error => {
      console.error(`Network error fetching space ${spaceId}:`, error);
      spaceCache.delete(spaceId); // Allow retry on next call
      return null;
    });
    spaceCache.set(spaceId, fetchPromise);
  }
  return spaceCache.get(spaceId);
}
