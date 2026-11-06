import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { request } from "node:http";
import { isLoopbackBindHost, resolveS2sSecret, startHttpTransport } from "../index.js";

// Obviously fake, not a real secret.
const FAKE_SECRET = "fake-test-secret-".padEnd(40, "0");

function withExit(fn: () => unknown): string {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  } finally {
    exit.mockRestore();
  }
}

describe("resolveS2sSecret", () => {
  it("accepts a >=32 char secret", () => {
    expect(resolveS2sSecret({ CONDUIT_S2S_SECRET: FAKE_SECRET }).secret).toBe(FAKE_SECRET);
  });
  it("rejects short secrets and placeholders without printing the value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases = ["short-secret-value", "changeme", "Change-Me", "secret", "placeholder", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "your-secret-goes-here-please-replace", "CHANGEME-" + "a".repeat(30)];
    for (const value of cases) {
      expect(withExit(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: value })), value).toBe("exit:1");
      const logged = err.mock.calls.map((c) => String(c[0])).join("");
      if (value.length > 12) expect(logged).not.toContain(value);
    }
    err.mockRestore();
  });
  it("rejects a short secret even with MCP_ALLOW_INSECURE_DEV=1; empty+dev is allowed", () => {
    expect(withExit(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: "tiny", MCP_ALLOW_INSECURE_DEV: "1" }))).toBe("exit:1");
    expect(withExit(() => resolveS2sSecret({}))).toBe("exit:1");
    expect(resolveS2sSecret({ MCP_ALLOW_INSECURE_DEV: "1" })).toEqual({ secret: "", insecureDev: true });
  });
});

describe("isLoopbackBindHost", () => {
  it("recognises loopback addresses only", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackBindHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.1", "example.com", "::", "128.0.0.1"]) expect(isLoopbackBindHost(h)).toBe(false);
  });
});

function send(port: number, opts: { host?: string; path?: string; body?: string; method?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: opts.path ?? "/mcp", method: opts.method ?? "POST", headers: { ...(opts.host ? { Host: opts.host } : {}), "Content-Type": "application/json", ...opts.headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(env: Record<string, string>): Promise<number> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = { MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: "127.0.0.1", PANDORA_BASE_URL: "https://pandora.example.com", ...env };
  for (const [k, v] of Object.entries(base)) vi.stubEnv(k, v);
  server = await startHttpTransport();
  return (server.address() as AddressInfo).port;
}

describe("Host header check (DNS rebinding)", () => {
  it("rejects unknown hosts with 403 and allows localhost, with or without port", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    expect((await send(port, { host: "evil.example.net", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "evil.example.net:80", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "localhost:99999", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "localhost", body: "{}" })).status).not.toBe(403);
    expect((await send(port, { host: `127.0.0.1:${port}`, body: "{}" })).status).not.toBe(403);
  });
  it("honours MCP_ALLOWED_HOSTS and warns on entries with ports", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await start({ CONDUIT_S2S_SECRET: FAKE_SECRET, MCP_ALLOWED_HOSTS: "mcp.example.com, bad.example.com:8080, ::1" });
    const logged = err.mock.calls.map((c) => String(c[0])).join("");
    err.mockRestore();
    expect(logged).toContain("bad.example.com:8080");
    expect(logged).toContain('"::1"');
    // Allowed host passes the host check and then fails S2S auth (401), not 403.
    expect((await send(port, { host: "mcp.example.com", body: "{}" })).status).toBe(401);
    expect((await send(port, { host: "other.example.com", body: "{}" })).status).toBe(403);
    expect((await send(port, { host: "bad.example.com:8080", body: "{}" })).status).toBe(403);
  });
  it("does not gate /health", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    expect((await send(port, { host: "evil.example.net", path: "/health", method: "GET" })).status).toBe(200);
  });
});

describe("request body limit", () => {
  it("returns 413 for a declared or streamed body over 1 MiB, 400 for bad JSON", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    const big = JSON.stringify({ pad: "a".repeat(1024 * 1024 + 10) });
    expect((await send(port, { body: big })).status).toBe(413);
    expect((await send(port, { body: "not json" })).status).toBe(400);
  });
  it("accepts a body under the limit", async () => {
    const port = await start({ MCP_ALLOW_INSECURE_DEV: "1" });
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const res = await send(port, { body: init, headers: { Accept: "application/json, text/event-stream" } });
    expect(res.status).toBe(200);
  });
});
