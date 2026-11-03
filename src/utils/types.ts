import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type { Tool, CallToolResult };

export type Tier = "read" | "write" | "admin";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ParamSpec {
  type: "string" | "integer" | "number" | "boolean" | "object" | "array";
  optional?: boolean;
  enum?: string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  /** v2 only: send as a query-string parameter instead of a JSON body field. */
  in?: "query";
  items?: { type: string; properties?: Record<string, ParamSpec> };
  properties?: Record<string, ParamSpec>;
}

/**
 * One element of the legacy `other` parameter, in the positional order given
 * by the docblock above `function api_<op>_<op2>(` in functions_api.php.
 */
export interface OtherField {
  /** Name of the tool input that supplies this positional value. */
  param: string;
  /** Value used when the input is omitted (only if a later field is sent). */
  default?: string;
  /** Boolean inputs: string sent for true / false. Defaults "1" / "0". */
  trueValue?: string;
  falseValue?: string;
  /** Array inputs: join the items into one positional value with this char. */
  join?: string;
  /** Array inputs: send each item as its own positional element. */
  spread?: boolean;
  /** Object inputs: expand to one `key,value` positional element per entry. */
  pairs?: boolean;
}

interface BaseEndpoint {
  tool: string;
  tier: Tier;
  description: string;
  destructive?: boolean;
  params: Record<string, ParamSpec>;
}

export interface V2Endpoint extends BaseEndpoint {
  api: "v2";
  method: HttpMethod;
  path: string;
}

export interface LegacyEndpoint extends BaseEndpoint {
  api: "legacy";
  op: "get" | "set";
  op2: string;
  /** Tool input mapped to the `id` query parameter. */
  id?: string;
  /** Tool input mapped to the `id2` query parameter. */
  id2?: string;
  /** Positional `other` fields, in docblock order. */
  other?: OtherField[];
  /** Always send at least this many `other` elements (empty strings pad). */
  otherMin?: number;
}

export type EndpointSpec = V2Endpoint | LegacyEndpoint;

export interface PandoraCredentials {
  token: string;
  baseUrl: string;
}

export interface ApiResult {
  ok: boolean;
  data?: unknown;
  error?: {
    kind: "config" | "auth" | "network" | "http" | "upstream" | "input";
    message: string;
  };
}
