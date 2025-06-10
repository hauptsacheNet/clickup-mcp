import { CallToolResult } from "@modelcontextprotocol/sdk/types";

// Define ContentBlock type alias for clarity
export type ContentBlock = CallToolResult['content'][number];

// Simplified Event Wrapper for date-based content
export interface DatedContentEvent {
  date: string; // Primary date for sorting this event
  contentBlocks: ContentBlock[]; // The actual content to be displayed for this event
}

// Configuration interface
export interface Config {
  apiKey: string;
  teamId: string;
  maxImages: number;
  primaryLanguageHint: string | undefined;
}