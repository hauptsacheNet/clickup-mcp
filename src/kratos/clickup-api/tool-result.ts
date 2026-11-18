import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { withoutToken } from "./errors";

export function toolText(lines: readonly string[]): CallToolResult {
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export function toolError(action: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const logged = error instanceof Error ? (error.stack ?? message) : message;
  // Errors from outside this module reach the model and stderr too, so the token is stripped here as well.
  console.error(withoutToken("Error " + action + ": " + logged));
  return { content: [{ type: "text", text: withoutToken("Error " + action + ": " + message) }], isError: true };
}
