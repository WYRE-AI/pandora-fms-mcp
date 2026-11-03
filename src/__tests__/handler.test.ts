import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, listTools } from "../utils/handler.js";
import { TOOL_TIERS } from "../tool-tiers.js";
import { ENDPOINTS } from "../endpoints.js";
import { DEFAULT_TIERS, getEnabledTiers } from "../tiers.js";
import type { PandoraCredentials } from "../utils/types.js";

const credentials: PandoraCredentials = { token: "tok-SECRET-0123456789", baseUrl: "https://pandora.example.com" };

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("tool registry", () => {
  it("lists exactly 33 read, 16 write and 6 admin tools (55 total)", () => {
    const tools = listTools(["read", "write", "admin"]);
    expect(tools).toHaveLength(55);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(55);
    const count = (tier: string) => Object.values(TOOL_TIERS).filter((info) => info.tier === tier).length;
    expect(count("read")).toBe(33);
    expect(count("write")).toBe(16);
    expect(count("admin")).toBe(6);
    expect(listTools(["read"])).toHaveLength(33);
    expect(listTools(["write"])).toHaveLength(16);
    expect(listTools(["admin"])).toHaveLength(6);
  });

  it("gives every tool a tier, a pandora_ name, and its API", () => {
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.tool).toMatch(/^pandora_[a-z0-9_]+$/);
      expect(["read", "write", "admin"]).toContain(TOOL_TIERS[endpoint.tool].tier);
    }
    expect(ENDPOINTS.filter((e) => e.api === "v2")).toHaveLength(23);
    expect(ENDPOINTS.filter((e) => e.api === "legacy")).toHaveLength(32);
  });

  it("carries the destructive warning and hint on every admin tool", () => {
    for (const tool of listTools(["admin"])) {
      expect(tool.description).toMatch(/^⚠ DESTRUCTIVE /);
      expect(tool.annotations?.destructiveHint).toBe(true);
    }
  });

  it("marks only read tools as read-only", () => {
    for (const tool of listTools(["read", "write", "admin"])) {
      const tier = TOOL_TIERS[tool.name].tier;
      expect(tool.annotations?.readOnlyHint).toBe(tier === "read");
    }
  });

  it("defaults to the read tier and rejects unknown tiers", () => {
    expect(DEFAULT_TIERS).toEqual(["read"]);
    expect(getEnabledTiers({})).toEqual(["read"]);
    expect(getEnabledTiers({ PANDORA_TOOL_TIERS: "read, write" })).toEqual(["read", "write"]);
    expect(() => getEnabledTiers({ PANDORA_TOOL_TIERS: "root" })).toThrow(/PANDORA_TOOL_TIERS/);
  });
});

describe("tier gating", () => {
  it("refuses a tool whose tier is not enabled and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("pandora_agent_delete", { agent_name: "x" }, credentials);
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unknown tools", async () => {
    expect((await callTool("pandora_nope", {}, credentials)).isError).toBe(true);
  });
});

describe("end-to-end mocked reads", () => {
  it("v2: pandora_ping_get", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ping: "pong" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("pandora_ping_get", {}, credentials);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text", text: JSON.stringify({ ping: "pong" }) });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pandora.example.com/pandora_console/api/v2/ping");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
  });

  it("legacy: pandora_agents_list", async () => {
    const rows = { type: "array", data: [{ id_agente: "1", alias: "web01" }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("pandora_agents_list", { filter_group: 2 }, credentials);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ text: JSON.stringify(rows) });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/pandora_console/include/api.php");
    expect(parsed.searchParams.get("op2")).toBe("all_agents");
    expect(parsed.searchParams.get("other")).toBe("|2");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
  });

  it("returns legacy error payloads as tool errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "error", data: "denied" }), { status: 200 })));
    const result = await callTool("pandora_tactical_view_get", {}, credentials);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: "Error: denied" });
  });

  it("runs an enabled write tool", async () => {
    vi.stubEnv("PANDORA_TOOL_TIERS", "read,write");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: "string", data: "OK" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("pandora_module_enable", { agent_name: "a", module_name: "m" }, credentials);
    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
