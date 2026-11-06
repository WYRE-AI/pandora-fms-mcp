#!/usr/bin/env node
// Offline smoke test: starts dist/index.js against a mock Pandora server on
// 127.0.0.1. No network access to any real Pandora host is made.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const seen = [];

function check(condition, message) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
}

const mock = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  seen.push({ path: url.pathname, query: url.search, auth: req.headers.authorization });
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/pandora_console/api/v2/ping") {
    res.end(JSON.stringify({ ping: "pong" }));
  } else if (url.pathname === "/pandora_console/include/api.php") {
    res.end(JSON.stringify({ type: "array", data: [{ id_agente: "1", alias: "web01" }] }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  }
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;
const textOf = (result) => result.content.map((c) => c.text ?? "").join("");

async function withServer(extraEnv, run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "dist/index.js")],
    env: { ...getDefaultEnvironment(), PANDORA_BASE_URL: mockUrl, PANDORA_API_TOKEN: "smoke-token", AUTH_MODE: "env", MCP_TRANSPORT: "stdio", LOG_LEVEL: "warn", ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "pandora-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

try {
  console.log("\n[1] tools/list tier counts");
  await withServer({ PANDORA_TOOL_TIERS: "read,write,admin" }, async (client) => {
    const { tools } = await client.listTools();
    check(tools.length === 55, "55 tools are listed");
    check(new Set(tools.map((t) => t.name)).size === 55, "tool names are unique");
  });
  await withServer({}, async (client) => {
    const { tools } = await client.listTools();
    check(tools.length === 33, "default tier lists 33 read tools");
  });

  console.log("\n[2] mocked v2 read");
  await withServer({}, async (client) => {
    const result = await client.callTool({ name: "pandora_ping_get", arguments: {} });
    check(result.isError !== true && textOf(result).includes("pong"), "pandora_ping_get returns the mocked response");
  });
  check(seen.at(-1)?.auth === "Bearer smoke-token" && seen.at(-1)?.query === "", "v2 request used Bearer header and no query");

  console.log("\n[3] mocked legacy read");
  await withServer({}, async (client) => {
    const result = await client.callTool({ name: "pandora_agents_list", arguments: { filter_group: 2 } });
    check(result.isError !== true && textOf(result).includes("web01"), "pandora_agents_list returns the mocked response");
  });
  const legacy = seen.at(-1);
  check(legacy?.auth === "Bearer smoke-token", "legacy request used Bearer header");
  check(legacy?.query.includes("op2=all_agents") && !legacy.query.includes("smoke-token"), "legacy query built; token not in URL");

  console.log("\n[4] gateway mode reads the token from X-Pandora-Token");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [resolve(root, "dist/index.js")], {
    env: { ...getDefaultEnvironment(), PANDORA_BASE_URL: mockUrl, AUTH_MODE: "gateway", MCP_TRANSPORT: "http", MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: "127.0.0.1", MCP_ALLOW_INSECURE_DEV: "1", LOG_LEVEL: "error" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      try { healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    check(healthy, "HTTP server is healthy");
    const noToken = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    check(noToken.status === 401, "request without X-Pandora-Token is rejected");
    const client = new Client({ name: "pandora-smoke-http", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { "X-Pandora-Token": "gateway-token" } } }));
    const result = await client.callTool({ name: "pandora_ping_get", arguments: {} });
    await client.close();
    check(result.isError !== true && seen.at(-1)?.auth === "Bearer gateway-token", "gateway token forwarded as Bearer");
  } finally {
    child.kill();
  }
} catch (error) {
  console.error("smoke test crashed:", error);
  failures.push("crash");
} finally {
  await new Promise((r) => mock.close(r));
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");
