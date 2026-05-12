#!/usr/bin/env node
import 'dotenv/config'; // Load .env file
import { z } from "zod";
import { serverPromise } from "./index";

function extractShape(schema: any): Record<string, any> | null {
  if (!schema) return null;
  if (schema._def?.shape) {
    return typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape;
  }
  if (schema._zod?.def?.shape) {
    return schema._zod.def.shape;
  }
  if (schema.shape) {
    return typeof schema.shape === "function" ? schema.shape() : schema.shape;
  }
  return null;
}

function safeParseSchema(schema: any, data: unknown):
  | { success: true; data: unknown }
  | { success: false; error: any } {
  if (typeof schema.safeParse === "function") {
    return schema.safeParse(data);
  }
  if (schema._zod) {
    const { safeParse } = require("zod/v4/core") as typeof import("zod/v4/core");
    return safeParse(schema, data) as any;
  }
  return { success: true, data };
}

async function main() {
  // Wait for server initialization to complete
  const server = await serverPromise;
  const args = process.argv.slice(2);
  
  // Special command to show instructions
  if (args.length === 1 && args[0] === 'instructions') {
    console.log("Server Instructions:");
    console.log((server.server as any)._instructions || "No instructions configured");
    process.exit(0);
  }

  // Special commands for testing resources
  if (args.length === 1 && args[0] === 'resources') {
    console.log("Listing available resources...");
    try {
      // @ts-ignore - Accessing private property for testing purposes
      const resourceTemplates = server._registeredResourceTemplates;
      
      if (resourceTemplates && Object.keys(resourceTemplates).length > 0) {
        for (const [name, template] of Object.entries(resourceTemplates)) {
          console.log(`Resource template: ${name}`);
          // @ts-ignore - Access template properties
          const uriTemplate = template.resourceTemplate.uriTemplate;
          console.log(`  URI Template: ${uriTemplate}`);
          
          // Test the list callback if available
          // @ts-ignore - Access template properties
          if (template.resourceTemplate._callbacks.list) {
            try {
              // @ts-ignore - Call list callback
              const result = await template.resourceTemplate._callbacks.list();
              console.log(`  Resources found: ${result.resources.length}`);
              result.resources.slice(0, 3).forEach((res: any, idx: number) => {
                console.log(`    ${idx + 1}. ${res.name} (${res.uri})`);
              });
              if (result.resources.length > 3) {
                console.log(`    ... and ${result.resources.length - 3} more`);
              }
            } catch (error) {
              console.log(`  Error listing resources: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }
          console.log("");
        }
      } else {
        console.log("No resource templates registered.");
      }
    } catch (error) {
      console.error("Error accessing resources:", error instanceof Error ? error.message : 'Unknown error');
    }
    process.exit(0);
  }

  // Special command to read a specific resource
  if (args.length === 2 && args[0] === 'resource') {
    const resourceUri = args[1];
    console.log(`Reading resource: ${resourceUri}`);
    try {
      // @ts-ignore - Accessing private property for testing purposes
      const resourceTemplates = server._registeredResourceTemplates;
      
      // Find matching template and call read callback
      for (const [name, template] of Object.entries(resourceTemplates)) {
        try {
          // @ts-ignore - Access template properties
          const result = await template.readCallback(new URL(resourceUri), {}, {} as any);
          console.dir(result, { depth: null });
          process.exit(0);
        } catch (error) {
          // Continue to next template if this one doesn't match
          continue;
        }
      }
      
      console.error("No matching resource template found for URI:", resourceUri);
      process.exit(1);
    } catch (error) {
      console.error("Error reading resource:", error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  }
  
  if (args.length < 1) {
    console.error("Usage: npm run cli <tool-name> [param1=value1 param2=value2 ...]");
    console.error("       npm run cli instructions");
    console.error("       npm run cli resources");
    console.error("       npm run cli resource <uri>");
    console.error("\nAvailable tools:");
    
    // @ts-ignore - Accessing private property for testing purposes
    const tools = server._registeredTools as Record<string, any>;

    if (tools) {
      for (const [name, tool] of Object.entries(tools)) {
        console.error(`  - ${name}: ${tool.description}`);
        const shape = extractShape(tool.inputSchema);
        if (shape) {
          console.error("    Parameters:");
          for (const [paramName, schema] of Object.entries(shape)) {
            const description = (schema as any)?.description
              ?? (schema as any)?._def?.description
              ?? (schema as any)?._zod?.def?.description
              ?? "No description";
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
    const tools = server._registeredTools as Record<string, any>;

    if (!tools || !tools[toolName]) {
      console.error(`Unknown tool: ${toolName}`);
      process.exit(1);
    }

    const tool = tools[toolName];
    const handler = tool.handler ?? tool.callback;

    if (tool.inputSchema) {
      const result = safeParseSchema(tool.inputSchema, params);
      if (!result.success) {
        console.error("Parameter validation error:", JSON.stringify(result.error?.issues ?? result.error, null, 2));
        process.exit(1);
      }
    } else if (Object.keys(params).length > 0) {
      console.error(`Error: Tool '${toolName}' does not accept any parameters, but parameters were provided.`);
      process.exit(1);
    }

    if (!process.env.CLICKUP_API_KEY || !process.env.CLICKUP_TEAM_ID) {
      console.warn("Warning: Using mock API credentials. This will not return real data.");
      process.env.CLICKUP_API_KEY = process.env.CLICKUP_API_KEY || 'test_api_key';
      process.env.CLICKUP_TEAM_ID = process.env.CLICKUP_TEAM_ID || 'test_team_id';
    }

    const extra = {
      signal: new AbortController().signal,
      requestId: "cli",
      sendNotification: async () => {},
      sendRequest: async () => ({}),
    } as any;
    const result = await handler(params, extra);
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
