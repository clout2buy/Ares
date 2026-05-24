import type { JsonRecord, JsonValue, ToolCall, ToolDefinition } from "@crix/protocol";

export interface OpenAIResponseFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: JsonRecord;
  strict: true;
}

export interface OllamaChatFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonRecord;
  };
}

export function openAIResponseTools(tools: ToolDefinition[]): OpenAIResponseFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: jsonSchemaForTool(tool),
    strict: true,
  }));
}

export function ollamaChatTools(tools: ToolDefinition[]): OllamaChatFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaForTool(tool),
    },
  }));
}

export function jsonSchemaForTool(tool: ToolDefinition): JsonRecord {
  const properties: JsonRecord = {};
  const required: string[] = [];
  for (const [key, hint] of Object.entries(tool.inputSchema)) {
    if (key === "ranges" || key.startsWith("_")) continue;
    properties[key] = strictJsonSchema(schemaForHint(hint));
    if (!String(hint).toLowerCase().includes("optional")) required.push(key);
  }
  return strictJsonSchema({
    type: "object",
    additionalProperties: false,
    properties,
    required,
  });
}

export function extractOpenAIResponseToolCalls(response: unknown): ToolCall[] {
  if (!isRecord(response)) return [];
  const output = Array.isArray(response.output) ? response.output : [];
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type !== "function_call") continue;
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) continue;
    calls.push({
      id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `openai_call_${calls.length + 1}`,
      name,
      input: parseArguments(item.arguments),
    });
  }
  return calls;
}

export function extractOllamaToolCalls(response: unknown): ToolCall[] {
  if (!isRecord(response) || !isRecord(response.message) || !Array.isArray(response.message.tool_calls)) return [];
  const calls: ToolCall[] = [];
  for (const item of response.message.tool_calls) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : item;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    calls.push({
      id: typeof item.id === "string" ? item.id : `ollama_call_${calls.length + 1}`,
      name,
      input: parseArguments(fn.arguments),
    });
  }
  return calls;
}

function schemaForHint(hint: JsonValue): JsonRecord {
  if (isRecord(hint)) return hint as JsonRecord;
  const text = String(hint).toLowerCase();
  if (text.includes("string[]") || text.includes("array")) {
    return { type: "array", items: { type: "string" } };
  }
  if (text.includes("number")) return { type: "number" };
  if (text.includes("boolean")) return { type: "boolean" };
  if (text.includes("object")) {
    return {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    };
  }
  return { type: "string" };
}

function strictJsonSchema(schema: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...schema };
  const type = typeof out.type === "string" ? out.type : undefined;
  if (type === "object" || isRecord(out.properties)) {
    const properties = isRecord(out.properties) ? out.properties : {};
    const normalizedProperties: JsonRecord = {};
    for (const [key, value] of Object.entries(properties)) {
      normalizedProperties[key] = isRecord(value) ? strictJsonSchema(value as JsonRecord) : value as JsonValue;
    }
    out.type = "object";
    out.properties = normalizedProperties;
    out.additionalProperties = false;
    if (!Array.isArray(out.required)) out.required = [];
  }
  if (type === "array" && isRecord(out.items)) {
    out.items = strictJsonSchema(out.items as JsonRecord);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = out[key];
    if (Array.isArray(variants)) {
      out[key] = variants.map((item) => isRecord(item) ? strictJsonSchema(item as JsonRecord) : item as JsonValue);
    }
  }
  return out;
}

function parseArguments(value: unknown): JsonRecord {
  if (isRecord(value)) return value as JsonRecord;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
