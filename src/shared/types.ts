import { CallToolResult } from "@modelcontextprotocol/sdk/types";

// Define ContentBlock type alias for clarity
export type ContentBlock = CallToolResult['content'][number];

// Image metadata block for lazy loading
export interface ImageMetadataBlock {
  type: "image_metadata";
  urls: string[]; // Array of image URLs (largest to smallest preference)
  alt: string; // Image description/filename
}

// Simplified Event Wrapper for date-based content
export interface DatedContentEvent {
  date: string; // Primary date for sorting this event
  contentBlocks: (ContentBlock | ImageMetadataBlock)[]; // The actual content to be displayed for this event
}

// Configuration interface
export interface Config {
  apiKey: string;
  teamId: string;
  maxImages: number;
  maxResponseSizeMB: number;
  primaryLanguageHint: string | undefined;
}