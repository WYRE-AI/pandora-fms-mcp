import type { CallToolResult, EndpointSpec, PandoraCredentials, Tool } from "./types.js";
import { execute } from "./client.js";
import { getEnabledTiers, isToolEnabled } from "../tiers.js";
import { TOOL_TIERS } from "../tool-tiers.js";
import { ENDPOINTS } from "../endpoints.js";

const DESTRUCTIVE_PREFIX = "⚠ DESTRUCTIVE";

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function getEndpoint(tool: string): EndpointSpec | undefined {
  return ENDPOINTS.find((endpoint) => endpoint.tool === tool);
}

function isReadOnly(endpoint: EndpointSpec): boolean {
  return endpoint.tier === "read";
}

function toTool(endpoint: EndpointSpec) {
  const required = Object.entries(endpoint.params)
    .filter(([, param]) => !param.optional)
    .map(([key]) => key);
  const description =
    endpoint.destructive === true && !endpoint.description.startsWith(DESTRUCTIVE_PREFIX)
      ? `${DESTRUCTIVE_PREFIX} ${endpoint.description}`
      : endpoint.description;
  return {
    name: endpoint.tool,
    description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(endpoint.params).map(([key, param]) => [key, toSchema(param)]),
      ),
      required,
    },
    annotations: {
      destructiveHint: endpoint.destructive === true,
      readOnlyHint: isReadOnly(endpoint),
    },
  };
}

function toSchema(param: import("./types.js").ParamSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: param.type === "integer" ? "integer" : param.type };
  if (param.enum) schema.enum = param.enum;
  if (param.pattern) schema.pattern = param.pattern;
  if (param.description) schema.description = param.description;
  if (param.minimum !== undefined) schema.minimum = param.minimum;
  if (param.maximum !== undefined) schema.maximum = param.maximum;
  if (param.items) {
    schema.items = param.items.properties
      ? {
          type: param.items.type,
          properties: Object.fromEntries(
            Object.entries(param.items.properties).map(([key, value]) => [key, toSchema(value)]),
          ),
        }
      : { type: param.items.type };
  }
  if (param.properties) {
    schema.properties = Object.fromEntries(
      Object.entries(param.properties).map(([key, value]) => [key, toSchema(value)]),
    );
  }
  return schema;
}

export function listTools(tiers: readonly string[] = getEnabledTiers()): Tool[] {
  const enabled = new Set(tiers);
  const tools = Object.entries(TOOL_TIERS)
    .map(([tool, info]) => ({ tool, info }))
    .filter(({ info }) => enabled.has(info.tier))
    .map(({ tool }) => getEndpoint(tool))
    .filter((endpoint): endpoint is EndpointSpec => Boolean(endpoint));
  return tools.map(toTool) as Tool[];
}

export async function callTool(
  tool: string,
  args: Record<string, unknown>,
  creds: PandoraCredentials,
): Promise<CallToolResult> {
  const endpoint = getEndpoint(tool);
  if (!endpoint) return errorResult(`Unknown tool: ${tool}`);
  if (!isToolEnabled(tool, getEnabledTiers())) {
    return errorResult(`Tool ${tool} requires the "${TOOL_TIERS[tool].tier}" tier, which is not enabled.`);
  }
  const result = await execute(endpoint, args, creds);
  if (!result.ok) return errorResult(`Error: ${result.error?.message ?? "Pandora request failed."}`);
  const data = result.data;
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data ?? null) }] };
}
