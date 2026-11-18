import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { withoutToken } from "./errors";

export function toolText(lines: readonly string[]): CallToolResult {
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export function toolError(action: string, error: unknown): CallToolResult {
  console.error("Error " + action + ":", error);
  const message = error instanceof Error ? error.message : String(error);
  // Errors from outside this module reach the model too, so the token is stripped here as well.
  return { content: [{ type: "text", text: "Error " + action + ": " + withoutToken(message) }], isError: true };
}
