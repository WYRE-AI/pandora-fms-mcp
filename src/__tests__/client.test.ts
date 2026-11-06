import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLegacyRequest,
  execute,
  getBaseUrl,
  getCredentials,
  legacyError,
  resolveBaseUrl,
} from "../utils/client.js";
import { ENDPOINTS } from "../endpoints.js";
import type { EndpointSpec, LegacyEndpoint, PandoraCredentials } from "../utils/types.js";

const TOKEN = "tok-SECRET-0123456789";
const credentials: PandoraCredentials = { token: TOKEN, baseUrl: "https://pandora.example.com" };

function endpoint(tool: string): EndpointSpec {
  const found = ENDPOINTS.find((item) => item.tool === tool);
  if (!found) throw new Error(`missing endpoint ${tool}`);
  return found;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init: RequestInit) => impl(String(url), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function lastCall(mock: ReturnType<typeof stubFetch>): { url: URL; init: RequestInit; raw: string } {
  const [raw, init] = mock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url: new URL(raw), init, raw: String(raw) };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("base URL safety", () => {
  it("allows https and loopback http, and strips trailing slashes", () => {
    expect(resolveBaseUrl("https://pandora.example.com")).toBe("https://pandora.example.com");
    expect(resolveBaseUrl("https://pandora.example.com/")).toBe("https://pandora.example.com");
    expect(resolveBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(resolveBaseUrl("http://localhost")).toBe("http://localhost");
  });

  it.each([
    "http://pandora.example.com",
    "https://user:secret@pandora.example.com",
    "https://:secret@pandora.example.com",
    "https://pandora.example.com/?apipass=1",
    "https://pandora.example.com/#frag",
    "ftp://pandora.example.com",
    "file:///etc/passwd",
    "not-a-url",
    "",
  ])("rejects unsafe PANDORA_BASE_URL %j", (value) => {
    expect(() => resolveBaseUrl(value)).toThrow(/PANDORA_BASE_URL/);
  });

  it("reads the configured base URL", () => {
    expect(getBaseUrl({ PANDORA_BASE_URL: "https://pandora.example.com" })).toBe("https://pandora.example.com");
  });
});

describe("credential resolution", () => {
  const env = { PANDORA_BASE_URL: "https://pandora.example.com", PANDORA_API_TOKEN: " env-token " };

  it("reads the env token in env mode", () => {
    expect(getCredentials(env)).toEqual({ token: "env-token", baseUrl: "https://pandora.example.com" });
  });

  it("errors when the env token is missing", () => {
    expect(getCredentials({ PANDORA_BASE_URL: env.PANDORA_BASE_URL })).toEqual({ error: "Missing PANDORA_API_TOKEN." });
  });

  it("gateway mode uses only the X-Pandora-Token header, never the env token", () => {
    expect(getCredentials(env, (name) => (name === "x-pandora-token" ? "hdr-token" : undefined))).toEqual({
      token: "hdr-token",
      baseUrl: "https://pandora.example.com",
    });
    const missing = getCredentials(env, () => undefined);
    expect(missing).toEqual({ error: "Missing X-Pandora-Token header (gateway mode requires it)." });
  });
});

describe("API v2 requests", () => {
  it("sends the Bearer token (header only) and no token in the URL", async () => {
    const mock = stubFetch(() => jsonResponse({ ok: true }));
    const result = await execute(endpoint("pandora_ping_get"), {}, credentials);
    expect(result.ok).toBe(true);
    const { raw, init, url } = lastCall(mock);
    expect(raw).toBe("https://pandora.example.com/pandora_console/api/v2/ping");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(raw).not.toContain(TOKEN);
    expect(url.search).toBe("");
    expect(init.redirect).toBe("manual");
  });

  it("URL-encodes path params and rejects dot segments", async () => {
    const mock = stubFetch(() => jsonResponse({}));
    await execute(endpoint("pandora_user_get"), { idUser: "a b/c?d" }, credentials);
    expect(lastCall(mock).raw).toBe("https://pandora.example.com/pandora_console/api/v2/user/a%20b%2Fc%3Fd");
    const bad = await execute(endpoint("pandora_user_get"), { idUser: ".." }, credentials);
    expect(bad.ok).toBe(false);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("sends list filters as a JSON body and paging as query params", async () => {
    const mock = stubFetch(() => jsonResponse({ data: [] }));
    await execute(endpoint("pandora_events_list"), { page: 1, sizePage: 20, sortDirection: "DESC", search: "disk", severity: [{ severity: "critical" }] }, credentials);
    const { raw, init } = lastCall(mock);
    expect(raw).toBe("https://pandora.example.com/pandora_console/api/v2/event/list?page=1&sizePage=20&sortDirection=DESC");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(String(init.body))).toEqual({ search: "disk", severity: [{ severity: "critical" }] });
  });

  it("builds write bodies from the swagger schema fields", async () => {
    const mock = stubFetch(() => jsonResponse({ idEvent: 5 }));
    await execute(endpoint("pandora_event_update"), { idEvent: 5, status: "validated" }, credentials);
    const { raw, init } = lastCall(mock);
    expect(raw).toBe("https://pandora.example.com/pandora_console/api/v2/event/5");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ status: "validated" });
  });

  it("validates required inputs, types and enums before any request", async () => {
    const mock = stubFetch(() => jsonResponse({}));
    expect((await execute(endpoint("pandora_group_create"), {}, credentials)).error?.message).toMatch(/name/);
    expect((await execute(endpoint("pandora_event_get"), { idEvent: "x" }, credentials)).ok).toBe(false);
    expect((await execute(endpoint("pandora_event_update"), { idEvent: 1, status: "bogus" }, credentials)).ok).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it("uses DELETE without a body", async () => {
    const mock = stubFetch(() => jsonResponse({}));
    await execute(endpoint("pandora_group_delete"), { idGroup: 3 }, credentials);
    const { init, raw } = lastCall(mock);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(raw).toMatch(/\/api\/v2\/group\/3$/);
  });
});

describe("legacy API requests", () => {
  const legacy = (tool: string) => endpoint(tool) as LegacyEndpoint;

  it("sends op/op2/id/id2 with the Bearer token and no secrets in the URL", async () => {
    const mock = stubFetch(() => jsonResponse({ type: "string", data: "ok" }));
    const result = await execute(endpoint("pandora_module_enable"), { agent_name: "web 01", module_name: "CPU" }, credentials);
    expect(result.ok).toBe(true);
    const { url, init, raw } = lastCall(mock);
    expect(url.origin + url.pathname).toBe("https://pandora.example.com/pandora_console/include/api.php");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(url.searchParams.get("op")).toBe("set");
    expect(url.searchParams.get("op2")).toBe("enable_module");
    expect(url.searchParams.get("id")).toBe("web 01");
    expect(url.searchParams.get("id2")).toBe("CPU");
    expect(url.searchParams.get("return_type")).toBe("json");
    expect(url.searchParams.has("other")).toBe(false);
    for (const forbidden of ["apipass", "user", "pass"]) expect(url.searchParams.has(forbidden)).toBe(false);
    expect(raw).not.toContain(TOKEN);
    expect(init.redirect).toBe("manual");
  });

  it("joins named inputs into `other` with | in docblock order", () => {
    const { url: rawUrl } = buildLegacyRequest(
      legacy("pandora_agents_list"),
      { filter_os: 1, filter_group: 2, filter_module_states: "warning", filter_name: "j", filter_policy: "2", csv_separator: "~", recursion: true },
      credentials,
    );
    const url = new URL(rawUrl);
    expect(url.searchParams.get("other")).toBe("1|2|warning|j|2|~|1");
    expect(url.searchParams.get("other_mode")).toBe("url_encode_separator_|");
    expect(url.toString()).toContain("other=1%7C2%7Cwarning%7Cj%7C2%7C");
  });

  it("leaves gaps empty, trims trailing empties and fills defaults only when needed", () => {
    const gap = buildLegacyRequest(legacy("pandora_agents_list"), { filter_group: 2 }, credentials).url;
    expect(new URL(gap).searchParams.get("other")).toBe("|2");
    const none = buildLegacyRequest(legacy("pandora_agents_list"), {}, credentials).url;
    expect(new URL(none).searchParams.has("other")).toBe(false);
    const defaults = buildLegacyRequest(legacy("pandora_agents_list"), { recursion: true }, credentials).url;
    expect(new URL(defaults).searchParams.get("other")).toBe("|||||;|1");
  });

  it("orders module_data fields as separator|period|tstart|tend", () => {
    const { url: rawUrl } = buildLegacyRequest(
      legacy("pandora_module_data_get"),
      { id_module: 17, period: 604800, start: "20161201T13:40", end: "20161215T13:40" },
      credentials,
    );
    const url = new URL(rawUrl);
    expect(url.searchParams.get("id")).toBe("17");
    expect(url.searchParams.get("other")).toBe(";|604800|20161201T13:40|20161215T13:40");
  });

  it("percent-encodes each positional value so the console's second urldecode is lossless", () => {
    const { url: rawUrl } = buildLegacyRequest(legacy("pandora_agents_list"), { filter_name: "100% a+b" }, credentials);
    const url = new URL(rawUrl);
    // After PHP's query decode the value is still element-encoded; "|" stays the separator.
    expect(url.searchParams.get("other")).toBe("|||100%25%20a%2Bb");
  });

  it("pads fixed-length `other` lists (tree_agents, delete_module, downtime create)", () => {
    expect(new URL(buildLegacyRequest(legacy("pandora_agents_tree_get"), {}, credentials).url).searchParams.get("other")).toBe(";|%20|");
    expect(
      new URL(buildLegacyRequest(legacy("pandora_module_delete"), { agent_name: "a", module_name: "m", simulate: true }, credentials).url).searchParams.get("other"),
    ).toBe("simulate|");
    expect(
      new URL(buildLegacyRequest(legacy("pandora_module_delete"), { agent_name: "a", module_name: "m", use_alias: true }, credentials).url).searchParams.get("other"),
    ).toBe("|1");
    const create = buildLegacyRequest(
      legacy("pandora_downtime_create"),
      { name: "pepito", description: "testing", date_from: "08-22-2015", date_to: "08-31-2015", id_group: 0, type_downtime: "quiet", type_execution: "periodically", type_periodicity: "weekly" },
      credentials,
    ).url;
    const parsed = new URL(create);
    expect(parsed.searchParams.get("id")).toBe("pepito");
    expect(parsed.searchParams.get("other")?.split("|")).toEqual([
      "testing", "08-22-2015", "08-31-2015", "0", "", "", "", "", "", "", "", "", "", "", "", "quiet", "periodically", "weekly",
    ]);
  });

  it("spreads agent_names, joins agent_ids with ';' and expands field pairs", () => {
    expect(new URL(buildLegacyRequest(legacy("pandora_agent_id_get"), { agent_names: ["a", "b"] }, credentials).url).searchParams.get("other")).toBe("a|b");
    expect(new URL(buildLegacyRequest(legacy("pandora_downtime_agents_add"), { id_downtime: 4, agent_ids: [1, 2, 3] }, credentials).url).searchParams.get("other")).toBe("1;2;3");
    const update = new URL(
      buildLegacyRequest(legacy("pandora_agent_field_update"), { agent: "pandora", use_alias: false, fields: { id_os: "1", alias: "pandora", comentarios: "ab" } }, credentials).url,
    );
    expect(update.searchParams.get("id")).toBe("pandora");
    expect(update.searchParams.get("id2")).toBe("0");
    expect(update.searchParams.get("other")).toBe("id_os,1|alias,pandora|comentarios,ab");
  });

  it("maps booleans to 1/0 and error_value to a flag/value pair", () => {
    expect(new URL(buildLegacyRequest(legacy("pandora_agent_enabled_set"), { agent_id: "7", disabled: true }, credentials).url).searchParams.get("other")).toBe("1");
    expect(new URL(buildLegacyRequest(legacy("pandora_agent_enabled_set"), { agent_id: "7", disabled: false }, credentials).url).searchParams.get("other")).toBe("0");
    expect(new URL(buildLegacyRequest(legacy("pandora_module_last_value_get"), { id_module: 3, error_value: "N/A" }, credentials).url).searchParams.get("other")).toBe("error_value|N/A");
    expect(new URL(buildLegacyRequest(legacy("pandora_module_last_value_get"), { id_module: 3 }, credentials).url).searchParams.has("other")).toBe(false);
  });

  it.each([
    ["pandora_agents_list", { filter_name: "a|b" }],
    ["pandora_agent_id_get", { agent_names: ["ok", "x|y"] }],
    ["pandora_module_enable", { agent_name: "a|b", module_name: "m" }],
    ["pandora_module_enable", { agent_name: "a", module_name: "m|n" }],
    ["pandora_agent_field_update", { agent: "a", fields: { alias: "x|y" } }],
    ["pandora_agent_field_update", { agent: "a", fields: { "a,b": "x" } }],
    ["pandora_alert_validate", { alert_template: "t", agent: "a", module: "m|x" }],
  ])("rejects '|' (and bad separators) for %s", async (tool, args) => {
    const mock = stubFetch(() => jsonResponse({}));
    const result = await execute(endpoint(tool), args as Record<string, unknown>, credentials);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("input");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("legacy error handling", () => {
  it.each([
    [{ type: "error", data: "The user has not enough permissions" }, "The user has not enough permissions"],
    ["Error: agent not found", "Error: agent not found"],
    ["auth error", "auth error"],
    ["IP 10.0.0.9 is not in ACL list", "IP 10.0.0.9 is not in ACL list"],
    ["Incorrect user credentials", "Incorrect user credentials"],
  ])("detects %j as an error", (data, message) => {
    expect(legacyError(data)).toBe(message);
  });

  it.each([[{ type: "array", data: [] }], [{ type: "string", data: "OK" }], ["OK,7.0,NG.774"], [[1, 2]]])(
    "does not flag %j",
    (data) => expect(legacyError(data)).toBeUndefined(),
  );

  it("turns legacy JSON error responses into tool errors even on HTTP 200", async () => {
    stubFetch(() => jsonResponse({ type: "error", data: "forbidden for this user" }));
    const result = await execute(endpoint("pandora_tactical_view_get"), {}, credentials);
    expect(result).toMatchObject({ ok: false, error: { kind: "upstream", message: "forbidden for this user" } });
  });

  it("turns legacy plain-text errors into tool errors", async () => {
    stubFetch(() => new Response("Error: could not delete", { status: 200 }));
    const result = await execute(endpoint("pandora_agent_delete"), { agent_name: "x" }, credentials);
    expect(result.ok).toBe(false);
  });

  it("returns plain-text success bodies as text", async () => {
    stubFetch(() => new Response("OK,7.0NG.774,Build 220101", { status: 200 }));
    const result = await execute(endpoint("pandora_legacy_test_get"), {}, credentials);
    expect(result).toEqual({ ok: true, data: "OK,7.0NG.774,Build 220101" });
  });
});

describe("HTTP error handling, redirects and redaction", () => {
  it("treats 3xx as an error and never follows it", async () => {
    const mock = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example.net/" } }));
    const result = await execute(endpoint("pandora_ping_get"), {}, credentials);
    expect(result).toMatchObject({ ok: false, error: { kind: "http" } });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(lastCall(mock).init.redirect).toBe("manual");
  });

  it("reports 401 as an auth error without leaking the token", async () => {
    stubFetch(() => jsonResponse({ message: `bad token ${TOKEN}`, hint: `Bearer ${TOKEN}` }, 401));
    const result = await execute(endpoint("pandora_ping_get"), {}, credentials);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("auth");
    expect(result.error?.message).not.toContain(TOKEN);
    expect(result.error?.message).toContain("[REDACTED]");
  });

  it("redacts the token from network errors and echoed bodies", async () => {
    stubFetch(() => {
      throw new Error(`connect failed (Authorization: Bearer ${TOKEN})`);
    });
    const failed = await execute(endpoint("pandora_ping_get"), {}, credentials);
    expect(failed.error?.kind).toBe("network");
    expect(failed.error?.message).not.toContain(TOKEN);

    stubFetch(() => new Response(`debug ${TOKEN}`, { status: 200 }));
    const echoed = await execute(endpoint("pandora_legacy_test_get"), {}, credentials);
    expect(JSON.stringify(echoed)).not.toContain(TOKEN);
  });

  it("surfaces upstream 5xx message bodies as errors", async () => {
    stubFetch(() => jsonResponse({ error: "boom" }, 500));
    const result = await execute(endpoint("pandora_event_get"), { idEvent: 1 }, credentials);
    expect(result).toMatchObject({ ok: false, error: { kind: "upstream" } });
    expect(result.error?.message).toContain("boom");
  });
});

describe("round-4 hardening", () => {
  it("redacts before truncating: a token straddling the 2000-char cut is not leaked", async () => {
    const prefix = "Pandora returned status 500: ";
    for (const offset of [1990, 1995, 1998]) {
      const pad = "a".repeat(offset - prefix.length);
      stubFetch(() => new Response(`${pad}${TOKEN}${"b".repeat(50)}`, { status: 500 }));
      const result = await execute(endpoint("pandora_ping_get"), {}, credentials);
      const message = result.error?.message ?? "";
      expect(message.length).toBeLessThanOrEqual(2000);
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(TOKEN.slice(0, 8));
    }
  });

  it("redacts the token inside successful JSON responses", async () => {
    stubFetch(() => jsonResponse({ note: `x ${TOKEN}`, nested: [{ a: `Bearer ${TOKEN}` }], n: 1 }));
    const result = await execute(endpoint("pandora_ping_get"), {}, credentials);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain(TOKEN);
    expect(JSON.stringify(result.data)).toContain("[REDACTED]");
    expect((result.data as { n: number }).n).toBe(1);
  });

  it("restricts sortField to [A-Za-z0-9_]+", async () => {
    const mock = stubFetch(() => jsonResponse({}));
    const bad = await execute(endpoint("pandora_event_get"), { idEvent: 1 }, credentials);
    expect(bad.ok).toBe(true);
    const list = ENDPOINTS.find((e) => e.api === "v2" && "sortField" in e.params);
    if (!list) throw new Error("no endpoint with sortField");
    const args = (field: string) => ({ ...Object.fromEntries(Object.entries(list.params).filter(([, s]) => !s.optional).map(([k]) => [k, 1])), sortField: field });
    for (const field of ["a b", "x;DROP", "name,desc", "a&b=1", "", "é"]) {
      const result = await execute(list, args(field), credentials);
      expect(result).toMatchObject({ ok: false, error: { kind: "input" } });
    }
    mock.mockClear();
    const ok = await execute(list, args("utimestamp_2"), credentials);
    expect(ok.ok).toBe(true);
  });

  it("rejects ',' in legacy other values (scalars, array items, object values)", () => {
    const find = (pred: (e: LegacyEndpoint) => boolean) => ENDPOINTS.find((e): e is LegacyEndpoint => e.api === "legacy" && pred(e))!;
    const update = find((e) => e.tool === "pandora_agent_field_update");
    expect(() => buildLegacyRequest(update, { agent: "1", fields: { alias: "a,b" } }, credentials)).toThrow(/","/);
    expect(() => buildLegacyRequest(update, { agent: "1", fields: { alias: "ab" } }, credentials)).not.toThrow();
    const scalarEp = find((e) => (e.other ?? []).some((f) => !f.pairs && !f.spread && !f.join) && Object.values(e.params).some((p) => p.type === "string"));
    const field = scalarEp.other!.find((f) => !f.pairs && !f.spread && !f.join && scalarEp.params[f.param]?.type === "string")!;
    const base = Object.fromEntries(Object.entries(scalarEp.params).filter(([, s]) => !s.optional).map(([k]) => [k, "v"]));
    expect(() => buildLegacyRequest(scalarEp, { ...base, [field.param]: "a,b" }, credentials)).toThrow(/","/);
  });

  it("reuses one undici Agent per CA path", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { getAgent } = await import("../utils/client.js");
    const dir = mkdtempSync(join(tmpdir(), "ca-"));
    const path = join(dir, "ca.pem");
    writeFileSync(path, "");
    vi.stubEnv("PANDORA_CA_CERT_FILE", path);
    const first = getAgent();
    expect(first).toBeDefined();
    expect(getAgent()).toBe(first);
    vi.unstubAllEnvs();
    expect(getAgent()).toBeUndefined();
  });
});
