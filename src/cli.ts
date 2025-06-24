#!/usr/bin/env node
import 'dotenv/config'; // Load .env file
import { z } from "zod";
import { serverPromise } from "./index";

async function main() {
  // Wait for server initialization to complete
  const server = await serverPromise;
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error("Usage: npm run cli <tool-name> [param1=value1 param2=value2 ...]");
    console.error("\nAvailable tools:");
    
    // @ts-ignore - Accessing private property for testing purposes
    const tools = server._registeredTools as Record<string, {
      description: string;
      inputSchema: z.ZodObject<any>;
      callback: (params: any) => Promise<any>;
    }>;
    
    if (tools) {
      for (const [name, tool] of Object.entries(tools)) {
        console.error(`  - ${name}: ${tool.description}`);
        if (tool.inputSchema && tool.inputSchema._def && typeof tool.inputSchema._def.shape === 'function') { 
          console.error("    Parameters:");
          const shape = tool.inputSchema._def.shape();
          for (const [paramName, schema] of Object.entries(shape)) {
            // @ts-ignore - Accessing schema description
            const description = schema.description || "No description";
            console.error(`      - ${paramName}: ${description}`);
          }
        } else {
          console.error("    Parameters: None"); 
        }
        console.error("");
      }
    }
    
    process.exit(1);
  }

  const toolName = args[0];
  const params: Record<string, any> = {};

  // Parse parameters
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const match = arg.match(/^([^=]+)=(.*)$/);
    
    if (match) {
      const [, key, value] = match;
      
      // Try to parse as JSON if it looks like a JSON value
      try {
        if (value.startsWith('{') || value.startsWith('[') || 
            value === 'true' || value === 'false' || 
            (value.startsWith('"') && value.endsWith('"')) ||
            (!isNaN(Number(value)) && !key.includes('id') && !value.startsWith('"'))) {
          params[key] = JSON.parse(value);
        } else {
          params[key] = value;
        }
      } catch (e) {
        params[key] = value;
      }
    }
  }

  try {
    // @ts-ignore - Accessing private property for testing purposes
    const tools = server._registeredTools as Record<string, {
      description: string;
      inputSchema: z.ZodObject<any>;
      callback: (params: any) => Promise<any>;
    }>;
    
    if (!tools || !tools[toolName]) {
      console.error(`Unknown tool: ${toolName}`);
      process.exit(1);
    }
    
    const tool = tools[toolName];
    
    // Validate parameters using the tool's schema, if it exists
    if (tool.inputSchema) {
      try {
        tool.inputSchema.parse(params);
      } catch (error) {
        const validationError = error as z.ZodError;
        console.error("Parameter validation error:", validationError.message);
        process.exit(1);
      }
    } else if (Object.keys(params).length > 0) {
      // If there's no schema, but parameters were provided, it's an error
      console.error(`Error: Tool '${toolName}' does not accept any parameters, but parameters were provided.`);
      process.exit(1);
    }
    
    // Mock environment variables for testing if they're not set
    if (!process.env.CLICKUP_API_KEY || !process.env.CLICKUP_TEAM_ID) {
      console.warn("Warning: Using mock API credentials. This will not return real data.");
      process.env.CLICKUP_API_KEY = process.env.CLICKUP_API_KEY || 'test_api_key';
      process.env.CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID || 'test_team_id';
    }
    
    // Call the tool's callback function
    const result = await tool.callback(params);
    console.dir(result.content);
    process.exit(0);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error("Error:", error.message);
    } else {
      console.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

main().catch(console.error);
