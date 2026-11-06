#!/usr/bin/env node
/**
 * Pandora FMS / Pandora Open MCP Server
 *
 * One MCP tool per endpoint of the Pandora FMS API v2 and the legacy
 * api.php. 33 read + 14 write + 8 admin = 55 tools. Tools are grouped by tier
 * (read | write | admin); only the tiers listed in PANDORA_TOOL_TIERS
 * (default "read") are listed or callable.
 *
 * Transports:
 * - stdio (default): reads PANDORA_BASE_URL and PANDORA_API_TOKEN from the environment.
 * - http: stateless Streamable HTTP (a fresh Server + Transport per POST /mcp).
 *
 * Auth modes (HTTP only):
 * - env (default): PANDORA_API_TOKEN from the process environment.
 * - gateway: the per-user API token arrives in the `X-Pandora-Token`
 *   request header on every request. Gateway mode never falls back to the
 *   environment token.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is set to a real
 * value (known placeholders are rejected). MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning, does not
 * enforce X-Gateway-S2S, and listens on 127.0.0.1 only. /health and /healthz
 * are unauthenticated and never read credentials.
 */

import { createServer as createHttpServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { listTools, callTool } from "./utils/handler.js";
import type { PandoraCredentials } from "./utils/types.js";
import { getCredentials, getBaseUrl } from "./utils/client.js";
import { getEnabledTiers } from "./tiers.js";
import { logger } from "./utils/logger.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * Public example values. A copied placeholder must not verify as a real secret.
 * Matched after trim + lowercase, so "Change-Me" is the same as "change-me".
 */
// SECURITY-REVIEW: placeholder deny-list for the S2S secret.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

/** Pattern placeholders such as "xxxxxxxx..." or "your-secret-here". */
const PLACEHOLDER_PATTERN = /^(x+|0+|your[-_ ]?(s2s[-_ ])?secret.*|change[-_ ]?me.*|replace[-_ ]?(with|me).*)$/i;

const LOOPBACK_HOST = "127.0.0.1";

/** Per-request credentials in gateway mode (no cross-tenant leakage). */
const requestCredentials = new AsyncLocalStorage<PandoraCredentials>();

function isGatewayAuth(): boolean {
  return process.env.MCP_TRANSPORT === "http" && (process.env.AUTH_MODE || "env").trim() === "gateway";
}

function resolveRequestCredentials(): PandoraCredentials | { error: string } {
  const scoped = requestCredentials.getStore();
  if (scoped) return scoped;
  // SECURITY-REVIEW: gateway mode never falls back to environment credentials.
  if (isGatewayAuth()) return { error: "Missing per-request credentials (gateway mode)." };
  return getCredentials();
}

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 * The secret value is never written to logs.
 */
export function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): { secret: string; insecureDev: boolean } {
  // SECURITY-REVIEW: S2S secret resolution (fail closed; dev bypass only when the secret is empty).
  const raw = (env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && (KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase()) || PLACEHOLDER_PATTERN.test(raw))) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw && raw.length < 32) {
    refuseStart("Refusing to start HTTP transport: CONDUIT_S2S_SECRET must be at least 32 characters (openssl rand -hex 32).");
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === "1") {
    return { secret: "", insecureDev: true };
  }
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1, even when MCP_HTTP_HOST is a wider address
 * such as 0.0.0.0. A real secret honors MCP_HTTP_HOST. When that variable is
 * unset the bind is 127.0.0.1; the container image sets 0.0.0.0 explicitly.
 */
function resolveBindHost(s2sSecret: string, env: NodeJS.ProcessEnv = process.env): string {
  // SECURITY-REVIEW: network exposure; unauthenticated dev mode is loopback-only.
  const configured = (env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

/**
 * Create a fresh MCP Server instance with all request handlers registered.
 *
 * Called ONCE for stdio mode, and ONCE PER HTTP REQUEST for the Streamable
 * HTTP transport. A fresh Server (and Transport) per request keeps the HTTP
 * transport stateless so every client can initialize independently.
 */
export function createFreshServer(): Server {
  const server = new Server(
    { name: "mcp-server-pandora-fms", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.onerror = (error) => {
    logger.error("MCP server error", { error: error instanceof Error ? error.message : String(error) });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Log the tool name only: arguments may contain personal data.
    logger.info("Tool call received", { tool: name });
    try {
      const credentials = resolveRequestCredentials();
      if ("error" in credentials) {
        return { content: [{ type: "text", text: `Error: ${credentials.error}` }], isError: true };
      }
      return await callTool(name, (args ?? {}) as Record<string, unknown>, credentials);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Tool call failed", { tool: name, error: message });
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

/**
 * Handle a single MCP HTTP request with a fresh, stateless Server + Transport.
 * When `creds` is supplied (gateway mode) the request is processed inside an
 * AsyncLocalStorage context so tool handlers pick up the per-request key
 * without cross-tenant leakage. Never rethrows.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  creds?: PandoraCredentials,
): Promise<void> {
  // Bound buffering before handing a parsed body to the SDK (including chunked uploads).
  let parsedBody: unknown;
  if (req.method === "POST") {
    const limit = 1024 * 1024;
    const tooLarge = () => {
      if (res.headersSent) return;
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: "Request body exceeds 1 MiB" }));
      req.resume();
    };
    if (Number(req.headers["content-length"]) > limit) {
      tooLarge();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      // Early return must not destroy the socket before the 413 is flushed.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit) {
          tooLarge();
          return;
        }
        chunks.push(buffer);
      }
      parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON request body" }));
      }
      return;
    }
  }
  const server = createFreshServer();
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    if (creds) {
      await requestCredentials.run(creds, () => transport.handleRequest(req, res, parsedBody));
    } else {
      await transport.handleRequest(req, res, parsedBody);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("MCP request handling failed", { error: message });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
}

async function startStdioTransport(): Promise<void> {
  const server = createFreshServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Pandora FMS MCP server running on stdio");
}

/**
 * Start the server with HTTP Streamable transport.
 *
 * Refuses to listen unless CONDUIT_S2S_SECRET is a real secret. In gateway
 * mode the credentials are read from X-Pandora-Token on each
 * request and a request without both is rejected; there is no fallback to env.
 */
export async function startHttpTransport(): Promise<HttpServer> {
  const { secret: s2sSecret, insecureDev } = resolveS2sSecret();
  const rawPort = process.env.MCP_HTTP_PORT ?? "8080";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    refuseStart("Refusing to start HTTP transport: MCP_HTTP_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(rawPort);
  const host = resolveBindHost(s2sSecret);
  if (insecureDev) {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
  }
  // SECURITY-REVIEW: auth mode selection. Anything other than env|gateway is refused.
  const authMode = (process.env.AUTH_MODE || "env").trim();
  if (authMode !== "env" && authMode !== "gateway") {
    refuseStart(`Refusing to start HTTP transport: AUTH_MODE must be "env" or "gateway" (got "${authMode}").`);
  }
  const isGatewayMode = authMode === "gateway";
  if (!isGatewayMode) {
    const credentials = getCredentials();
    if ("error" in credentials) {
      logger.warn(`AUTH_MODE=env but Pandora credentials are not set: ${credentials.error}`);
    }
  }

  const checkHost = process.env.MCP_ALLOWED_HOSTS !== undefined || !s2sSecret || isLoopbackBindHost(host);
  const configuredHosts = (process.env.MCP_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  for (const entry of configuredHosts) {
    if (entry.includes(":") && !/^\[[0-9a-f:]+\]$/i.test(entry)) {
      logger.warn(`MCP_ALLOWED_HOSTS entry "${entry}" contains a port or unbracketed IPv6 address and will never match.`);
    }
  }
  const allowedHosts = new Set([
    "localhost", "127.0.0.1", "[::1]",
    ...configuredHosts.map((h) => h.toLowerCase()),
  ]);
  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");

    // Shallow, unauthenticated liveness probe. Must NOT read credentials or call upstream.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Match the entire Host authority, allowing only an optional numeric port.
    const authority = req.headers.host?.toLowerCase();
    const hostMatch = authority?.match(/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/);
    if (checkHost && (!hostMatch || (hostMatch[2] !== undefined && (Number(hostMatch[2]) < 1 || Number(hostMatch[2]) > 65535)) || !allowedHosts.has(hostMatch[1]))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Host not allowed" }));
      return;
    }

    if (url.pathname === "/mcp") {
      // SECURITY-REVIEW: X-Gateway-S2S check. Enforced before any Pandora credential is read.
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          }),
        );
        return;
      }

      if (isGatewayMode) {
        // SECURITY-REVIEW: gateway credential path. Reject explicitly when missing; never fall through to env.
        const credentials = getCredentials(undefined, (name) => headerValue(req.headers[name]));
        if ("error" in credentials) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing credentials", message: credentials.error }));
          return;
        }
        void handleMcpRequest(req, res, credentials);
        return;
      }

      void handleMcpRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info(`Pandora FMS MCP server listening on http://${host}:${actualPort}/mcp`);
      logger.info(`Health check available at http://${host}:${actualPort}/health`);
      logger.info(
        `Authentication mode: ${isGatewayMode ? "gateway (X-Pandora-Token headers)" : "env (PANDORA_API_TOKEN environment variable)"}`,
      );
      resolve();
    });
  });

  return httpServer;
}

/** Main entry point - select transport based on MCP_TRANSPORT env var. */
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";

  // Fail fast on bad configuration (before accepting any request).
  // In stdio mode an UNSET PANDORA_BASE_URL is allowed so the server can start and every
  // tool returns a clear is_error (the CI canary relies on this). A set-but-invalid
  // value, and any problem in http mode, still fails startup.
  const baseUrlUnsetInStdio = transportType !== "http" && !(process.env.PANDORA_BASE_URL ?? "").trim();
  const baseUrl = baseUrlUnsetInStdio ? undefined : getBaseUrl();
  if (baseUrlUnsetInStdio) logger.warn("PANDORA_BASE_URL is not set; tools will return an error until it is configured.");
  const tiers = [...getEnabledTiers()]; // throws on an unknown tier name
  logger.info("Starting Pandora FMS MCP server", {
    transport: transportType,
    apiBaseUrl: baseUrl,
    enabledTiers: tiers,
    toolCount: listTools().length,
    logLevel: process.env.LOG_LEVEL || "info",
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      logger.info("Shutting down Pandora FMS MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    const credentials = getCredentials();
    if ("error" in credentials) {
      logger.warn(`Pandora credentials are not set: ${credentials.error}`);
    }
    await startStdioTransport();
  }
}

// Vitest imports this module. Skip the CLI entrypoint there.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    logger.error("Fatal startup error", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
