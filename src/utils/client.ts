import { readFileSync } from "node:fs";
import { Agent } from "undici";
import type {
  ApiResult,
  EndpointSpec,
  LegacyEndpoint,
  OtherField,
  ParamSpec,
  PandoraCredentials,
  V2Endpoint,
} from "./types.js";

export const V2_PREFIX = "/pandora_console/api/v2";
export const LEGACY_PATH = "/pandora_console/include/api.php";
export const OTHER_MODE = "url_encode_separator_|";
export const OTHER_SEPARATOR = "|";
export const TOKEN_HEADER = "X-Pandora-Token";
export const REQUEST_TIMEOUT_MS = 30_000;

/** Thrown for invalid tool input; surfaced to the model as a tool error. */
export class InputError extends Error {}

/**
 * Validate PANDORA_BASE_URL. https only (http only for localhost/127.0.0.1,
 * used by tests); no userinfo, query or fragment. Trailing slashes are removed.
 */
export function resolveBaseUrl(raw?: string): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("PANDORA_BASE_URL is required (for example https://pandora.example.com).");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid PANDORA_BASE_URL: not a valid URL.");
  }
  if (url.username || url.password) {
    throw new Error("Invalid PANDORA_BASE_URL: userinfo is not allowed.");
  }
  if (url.hash || url.search) {
    throw new Error("Invalid PANDORA_BASE_URL: query strings and fragments are not allowed.");
  }
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost") {
      throw new Error("Invalid PANDORA_BASE_URL: http is only allowed for localhost.");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("Invalid PANDORA_BASE_URL: only https is allowed except http://127.0.0.1 and http://localhost.");
  }
  if (!url.hostname) throw new Error("Invalid PANDORA_BASE_URL: hostname is required.");
  return value.replace(/\/+$/, "");
}

export function getBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl(env.PANDORA_BASE_URL);
}

/**
 * Resolve the per-user API token. Env mode reads PANDORA_API_TOKEN; when a
 * header getter is supplied (gateway mode) the token comes only from the
 * X-Pandora-Token header and the environment token is never used.
 */
export function getCredentials(
  env: NodeJS.ProcessEnv = process.env,
  getHeader?: (name: string) => string | undefined,
): PandoraCredentials | { error: string } {
  const baseUrl = getBaseUrl(env);
  if (getHeader) {
    const token = (getHeader(TOKEN_HEADER.toLowerCase()) ?? "").trim();
    if (!token) return { error: `Missing ${TOKEN_HEADER} header (gateway mode requires it).` };
    return { token, baseUrl };
  }
  const token = (env.PANDORA_API_TOKEN ?? "").trim();
  if (!token) return { error: "Missing PANDORA_API_TOKEN." };
  return { token, baseUrl };
}

export function redactSecrets(text: string, secrets: string[]): string {
  const bearer = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  return secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[REDACTED]") : acc), bearer);
}

export const MAX_MESSAGE_CHARS = 2000;

/** Redact first, then truncate, so a secret split by the cut is never half-shown. */
export function redactAndTruncate(text: string, secrets: string[]): string {
  return redactSecrets(text, secrets).slice(0, MAX_MESSAGE_CHARS);
}

/** Redact every string in a (JSON) value, including object keys' values and array items. */
export function redactData(data: unknown, secrets: string[]): unknown {
  if (typeof data === "string") return redactSecrets(data, secrets);
  if (Array.isArray(data)) return data.map((item) => redactData(item, secrets));
  if (typeof data === "object" && data !== null) {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [redactSecrets(key, secrets), redactData(value, secrets)]),
    );
  }
  return data;
}

function errorResult(kind: NonNullable<ApiResult["error"]>["kind"], message: string): ApiResult {
  return { ok: false, error: { kind, message } };
}

const agentCache = new Map<string, Agent>();

/** One undici Agent per CA path, reused across calls. */
export function getAgent(): Agent | undefined {
  const certPath = process.env.PANDORA_CA_CERT_FILE;
  if (!certPath) return undefined;
  const cached = agentCache.get(certPath);
  if (cached) return cached;
  const ca = readFileSync(certPath, "utf8");
  const agent = new Agent({ connect: { ca } });
  agentCache.set(certPath, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function checkType(name: string, spec: ParamSpec, value: unknown): void {
  const fail = (expected: string): never => {
    throw new InputError(`Invalid input "${name}": expected ${expected}.`);
  };
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") fail("a string");
      if (spec.enum && !spec.enum.includes(value as string)) fail(`one of ${spec.enum.join(", ")}`);
      if (spec.pattern && !new RegExp(spec.pattern).test(value as string)) fail(`a string matching ${spec.pattern}`);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) fail("an integer");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("a number");
      break;
    case "boolean":
      if (typeof value !== "boolean") fail("a boolean");
      break;
    case "array":
      if (!Array.isArray(value)) fail("an array");
      break;
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail("an object");
      break;
  }
  if ((spec.type === "integer" || spec.type === "number") && typeof value === "number") {
    if (spec.minimum !== undefined && value < spec.minimum) fail(`a value >= ${spec.minimum}`);
    if (spec.maximum !== undefined && value > spec.maximum) fail(`a value <= ${spec.maximum}`);
  }
}

/** Check required inputs and types; returns only the inputs that were provided. */
export function validateArgs(endpoint: EndpointSpec, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(endpoint.params)) {
    const value = args[name];
    if (value === undefined || value === null) {
      if (!spec.optional) throw new InputError(`Missing required input "${name}".`);
      continue;
    }
    checkType(name, spec, value);
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// API v2
// ---------------------------------------------------------------------------

export function buildV2Request(
  endpoint: V2Endpoint,
  args: Record<string, unknown>,
  creds: PandoraCredentials,
): { url: string; init: RequestInit } {
  let path = endpoint.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    const spec = endpoint.params[name];
    if (!spec) continue;
    if (path.includes(`{${name}}`)) {
      const text = String(value);
      if (text === "." || text === ".." || text === "") {
        throw new InputError(`Invalid input "${name}".`);
      }
      path = path.split(`{${name}}`).join(encodeURIComponent(text));
    } else if (spec.in === "query") {
      query.set(name, String(value));
    } else {
      body[name] = value;
    }
  }
  const qs = query.toString();
  const url = `${creds.baseUrl}${V2_PREFIX}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.token}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method: endpoint.method, headers };
  if (endpoint.method === "POST" || endpoint.method === "PUT") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return { url, init };
}

// ---------------------------------------------------------------------------
// Legacy api.php
// ---------------------------------------------------------------------------

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  throw new InputError("Unsupported input value.");
}

function rejectSeparator(name: string, value: string): string {
  if (value.includes(OTHER_SEPARATOR)) {
    throw new InputError(`Invalid input "${name}": the "|" character is not allowed (it is the legacy API field separator).`);
  }
  return value;
}

function rejectComma(name: string, value: string): string {
  if (value.includes(",")) {
    throw new InputError(`Invalid input "${name}": the "," character is not allowed in values.`);
  }
  return value;
}

/** Reject both separators in one positional value. */
function checkValue(name: string, value: string): string {
  return rejectComma(name, rejectSeparator(name, value));
}

function otherElements(field: OtherField, value: unknown): string[] {
  const name = field.param;
  if (value === undefined || value === null) {
    return field.default !== undefined ? [checkValue(name, field.default)] : [""];
  }
  if (field.pairs) {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.map(([key, val]) => {
      const text = scalar(val);
      if (key.includes(",")) {
        throw new InputError(`Invalid input "${name}": "," is not allowed in field names.`);
      }
      rejectComma(name, text);
      return rejectSeparator(name, `${key},${text}`);
    });
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => checkValue(name, scalar(item)));
    return field.spread ? items : [items.join(field.join ?? ",")];
  }
  if (typeof value === "boolean") {
    return [value ? (field.trueValue ?? "1") : (field.falseValue ?? "0")];
  }
  return [checkValue(name, scalar(value))];
}

/**
 * Build the legacy api.php URL. Positional `other` values are percent-encoded
 * individually (the console urldecodes each element after splitting on "|"),
 * joined with "|", and the whole string is then query-encoded. The API token
 * never appears in the URL: it travels in the Authorization header.
 */
export function buildLegacyRequest(
  endpoint: LegacyEndpoint,
  args: Record<string, unknown>,
  creds: PandoraCredentials,
): { url: string; init: RequestInit } {
  const query = new URLSearchParams();
  query.set("op", endpoint.op);
  query.set("op2", endpoint.op2);
  if (endpoint.id) {
    const value = args[endpoint.id];
    if (value !== undefined) query.set("id", rejectSeparator(endpoint.id, scalar(value)));
  }
  if (endpoint.id2) {
    const value = args[endpoint.id2];
    if (value !== undefined) query.set("id2", rejectSeparator(endpoint.id2, scalar(value)));
  }
  // Reject "|" in every string input, even ones that are not forwarded.
  for (const [name, value] of Object.entries(args)) {
    if (typeof value === "string") rejectSeparator(name, value);
  }
  if (endpoint.other) {
    let elements: string[] = [];
    const isDefault: boolean[] = [];
    for (const field of endpoint.other) {
      const provided = args[field.param] !== undefined && args[field.param] !== null;
      for (const element of otherElements(field, args[field.param])) {
        elements.push(element);
        isDefault.push(!provided);
      }
    }
    const min = endpoint.otherMin ?? 0;
    // Trailing omitted fields (empty or defaulted) are not sent.
    while (elements.length > min && (elements[elements.length - 1] === "" || isDefault[elements.length - 1])) {
      elements.pop();
      isDefault.pop();
    }
    while (elements.length < min) elements.push("");
    elements = elements.map((element) => encodeURIComponent(element).replace(/%3B/gi, ";").replace(/%2C/gi, ",").replace(/%2F/gi, "/").replace(/%3A/gi, ":"));
    if (elements.length > 0) {
      query.set("other", elements.join(OTHER_SEPARATOR));
      query.set("other_mode", OTHER_MODE);
    }
  }
  query.set("return_type", "json");
  return {
    url: `${creds.baseUrl}${LEGACY_PATH}?${query.toString()}`,
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
    },
  };
}

const LEGACY_ERROR_TEXT = /^\s*(error\b|auth error|incorrect |ip \S+ is not in acl)/i;

/** Return an error message if a legacy api.php response is an error. */
export function legacyError(data: unknown): string | undefined {
  if (typeof data === "string") {
    return LEGACY_ERROR_TEXT.test(data) ? data.trim() : undefined;
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as { type?: unknown; data?: unknown; message?: unknown };
    if (typeof record.type === "string" && record.type.toLowerCase() === "error") {
      const detail = record.data ?? record.message;
      return typeof detail === "string" ? detail : JSON.stringify(detail ?? "Legacy API error");
    }
    if (typeof record.data === "string" && LEGACY_ERROR_TEXT.test(record.data) && record.type === "string") {
      return record.data.trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function execute(
  endpoint: EndpointSpec,
  rawArgs: Record<string, unknown>,
  creds: PandoraCredentials,
): Promise<ApiResult> {
  const secrets = [creds.token];
  let request: { url: string; init: RequestInit };
  try {
    const args = validateArgs(endpoint, rawArgs);
    request = endpoint.api === "v2"
      ? buildV2Request(endpoint, args, creds)
      : buildLegacyRequest(endpoint, args, creds);
  } catch (error) {
    if (error instanceof InputError) return errorResult("input", error.message);
    throw error;
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      ...request.init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      dispatcher: getAgent() as never,
    } as RequestInit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult("network", redactSecrets(`Request to Pandora failed: ${message}`, secrets));
  }

  if (response.status >= 300 && response.status < 400) {
    return errorResult("http", `Pandora returned an unexpected redirect (status ${response.status}); redirects are not followed.`);
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const kind = response.status === 401 || response.status === 403 ? "auth" : "upstream";
    const detail =
      typeof data === "object" && data !== null
        ? ((data as { message?: unknown; error?: unknown }).message ?? (data as { error?: unknown }).error ?? data)
        : data;
    const message = typeof detail === "string" ? detail : JSON.stringify(detail);
    return errorResult(kind, redactAndTruncate(`Pandora returned status ${response.status}: ${message}`, secrets));
  }

  if (endpoint.api === "legacy") {
    const legacy = legacyError(data);
    if (legacy !== undefined) return errorResult("upstream", redactAndTruncate(legacy, secrets));
  }
  return { ok: true, data: redactData(data, secrets) };
}
