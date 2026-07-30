#!/usr/bin/env node
/**
 * Smoke test across the real MCP protocol layer.
 *
 * `npm run cli` calls tool callbacks directly, so it never exercises stdio transport,
 * tool registration or the JSON schemas a client actually sees. This spawns the built
 * server as a subprocess and talks JSON-RPC to it the way a client would.
 *
 *   npm run build && npm run smoke                        # list tools only
 *   npm run build && npm run smoke -- <task_id> <image>   # also post a comment
 *
 * With a task_id it WRITES a real comment, so point it at a scratch task.
 */
import "dotenv/config";
import { spawn } from "child_process";
import { resolve } from "path";

const [taskId, imagePath] = process.argv.slice(2);

const child = spawn("node", [resolve(__dirname, "../dist/index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  // Force write mode: the ambient CLICKUP_MCP_MODE may hide the tools under test.
  env: { ...process.env, CLICKUP_MCP_MODE: "write" },
});

let buffer = "";
const pending = new Map<number, (msg: any) => void>();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolver = msg.id != null ? pending.get(msg.id) : undefined;
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    } catch {
      // Not a JSON-RPC frame - ignore
    }
  }
});

// The server logs to stderr by design; surface only hard failures
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  if (/error|throw|unhandled/i.test(text)) {
    process.stderr.write(`[server] ${text}`);
  }
});

let nextId = 1;
function rpc(method: string, params?: any): Promise<any> {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method: string, params?: any): void {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function main() {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
    if (!ok) failures++;
  };

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "protocol-smoke", version: "1.0" },
  });
  check(
    "initialize",
    Boolean(init.result),
    init.result
      ? `${init.result.serverInfo?.name} ${init.result.serverInfo?.version}`
      : JSON.stringify(init.error)
  );
  notify("notifications/initialized");

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools || [];
  check("tools/list", tools.length > 0, `${tools.length} tools`);

  // Every tool must expose a usable schema, or clients cannot call it
  const malformed = tools.filter(
    (t: any) => !t.description || !t.inputSchema || t.inputSchema.type !== "object"
  );
  check("all tools have an object inputSchema", malformed.length === 0,
    malformed.map((t: any) => t.name).join(", "));

  const writeTools = ["addComment", "createTask", "updateTask"];
  for (const name of writeTools) {
    const tool = tools.find((t: any) => t.name === name);
    check(`${name} documents image support`,
      /local file path/i.test(tool?.description || ""));
  }

  if (taskId && imagePath) {
    const comment = [
      "**Protokoll-Smoke-Test** - dieser Kommentar kam über MCP/stdio.",
      "",
      `![Bild aus dem Smoke-Test](${resolve(imagePath)})`,
    ].join("\n");

    const call = await rpc("tools/call", {
      name: "addComment",
      arguments: { task_id: taskId, comment },
    });
    const text: string = call.result?.content?.[0]?.text || "";
    check("tools/call addComment", /Comment added successfully/.test(text),
      call.error ? JSON.stringify(call.error) : "");
    check("image was attached", /images_attached: 1/.test(text),
      (text.match(/WARNING.*/) || [""])[0]);
  } else {
    console.log("\nSkipped the write test. Pass a task id and image to run it:");
    console.log("  npm run smoke -- <task_id> ./screenshot.png");
  }

  child.kill();
  console.log(failures === 0 ? "\nAll protocol checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  child.kill();
  process.exit(1);
});
