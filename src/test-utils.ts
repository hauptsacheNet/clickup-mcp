import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";

/**
 * A simple utility to test MCP tools directly without using the StdioServerTransport
 */
export class ToolTester {
  private server: McpServer;

  constructor(server: McpServer) {
    this.server = server;
  }

  /**
   * Test a tool by name with the provided parameters
   * @param toolName The name of the tool to test
   * @param params The parameters to pass to the tool
   * @returns A promise that resolves to the tool's result
   */
  async testTool(toolName: string, params: Record<string, any>): Promise<CallToolResult> {
    // @ts-ignore - Accessing private property for testing purposes
    const tools = this.server._registeredTools as Record<string, {
      description: string;
      inputSchema: any;
      callback: (params: any) => Promise<CallToolResult>;
    }>;
    
    if (!tools || !tools[toolName]) {
      throw new Error(`Tool "${toolName}" not found`);
    }
    
    const tool = tools[toolName];
    
    // Validate parameters using the tool's schema
    try {
      tool.inputSchema.parse(params);
    } catch (error) {
      throw new Error(`Parameter validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Call the tool's callback directly with the provided parameters
    return await tool.callback(params);
  }
}

/**
 * Create a tool tester for the provided server
 * @param server The MCP server instance
 * @returns A ToolTester instance
 */
export function createToolTester(server: McpServer): ToolTester {
  return new ToolTester(server);
}
