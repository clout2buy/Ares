import type { JsonRecord, ProviderResponse, ToolCall } from "@crix/protocol";
import { parseUpgradePlan } from "@crix/protocol";

export function parseProviderJsonResponse(text: string): ProviderResponse {
  const parsed = JSON.parse(text) as unknown;
  const toolCalls = parseToolCalls(parsed);
  if (toolCalls) {
    return {
      text: readText(parsed) ?? `requested ${toolCalls.length} tool call(s)`,
      toolCalls,
    };
  }
  const plan = parseUpgradePlan(parsed);
  return { text: plan.summary, plan };
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!isRecord(value)) return undefined;
  const rawCalls = Array.isArray(value.toolCalls) ? value.toolCalls : Array.isArray(value.tool_calls) ? value.tool_calls : undefined;
  if (!rawCalls) return undefined;
  return rawCalls.map((raw, index) => {
    if (!isRecord(raw)) throw new Error("tool call must be an object");
    const name = readString(raw.name) ?? readString(raw.tool);
    if (!name) throw new Error("tool call name is required");
    const input = isRecord(raw.input) ? raw.input : isRecord(raw.arguments) ? raw.arguments : {};
    return {
      id: readString(raw.id) ?? `call_${index + 1}`,
      name,
      input: input as JsonRecord,
    };
  });
}

export function providerResponseToolCalls(response: ProviderResponse, allowedToolNames: Iterable<string>): ToolCall[] {
  if (response.toolCalls?.length) return response.toolCalls;
  return extractInlineToolCalls(response.text, allowedToolNames);
}

export function extractInlineToolCalls(text: string, allowedToolNames: Iterable<string>, maxCalls = 12): ToolCall[] {
  const allowed = Array.from(new Set(allowedToolNames)).filter(Boolean);
  if (!allowed.length || !text.trim()) return [];

  const masked = maskFencedCode(text);
  const names = allowed.sort((left, right) => right.length - left.length).map(escapeRegExp).join("|");
  const pattern = new RegExp(`\\b(${names})\\s*\\(`, "g");
  const calls: ToolCall[] = [];

  let match: RegExpExecArray | null;
  while (calls.length < maxCalls && (match = pattern.exec(masked))) {
    const name = match[1]!;
    const parenIndex = match.index + match[0].length - 1;
    const objectStart = skipWhitespace(masked, parenIndex + 1);
    if (masked[objectStart] !== "{") {
      pattern.lastIndex = parenIndex + 1;
      continue;
    }

    const objectEnd = findJsonObjectEnd(masked, objectStart);
    if (objectEnd < 0) {
      pattern.lastIndex = parenIndex + 1;
      continue;
    }

    const closeParen = skipWhitespace(masked, objectEnd + 1);
    if (masked[closeParen] !== ")") {
      pattern.lastIndex = objectEnd + 1;
      continue;
    }

    try {
      const input = JSON.parse(text.slice(objectStart, objectEnd + 1)) as unknown;
      if (isRecord(input)) {
        calls.push({ id: `inline_${calls.length + 1}`, name, input: input as JsonRecord });
      }
    } catch {
      // The model wrote something tool-shaped but not valid JSON; leave it as text.
    }
    pattern.lastIndex = closeParen + 1;
  }

  return calls;
}

function readText(value: unknown): string | undefined {
  return isRecord(value) ? readString(value.text) ?? readString(value.summary) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length));
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}

function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
