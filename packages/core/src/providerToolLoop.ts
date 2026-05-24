import type { AgentDefinition, ContextBundle, Message, ProviderResponse, ToolDefinition, ToolResult, UpgradePlan } from "@crix/protocol";
import type { ModelProvider } from "./provider.js";
import { providerResponseToolCalls } from "./providerResponse.js";
import { TurnEngine, type TurnEngineCall } from "./turnEngine.js";
import { id, nowIso } from "./util.js";

export interface ProviderToolLoopInput {
  goal: string;
  systemPrompt: string;
  context: ContextBundle;
  tools: ToolDefinition[];
  agents: AgentDefinition[];
  messages: Message[];
  provider: ModelProvider;
  engine: TurnEngine;
  maxRounds?: number;
  mode?: "plan" | "chat";
  requireToolUse?: boolean;
  toolUseCorrection?: string;
  maxToolUseRequirementRetries?: number;
  onEvent?: (event: ProviderToolLoopEvent) => void | Promise<void>;
  drainQueuedMessages?: () => Message[];
}

export type ProviderToolLoopEvent =
  | { type: "assistant"; round: number; text: string; toolCallCount: number }
  | { type: "tool_start"; round: number; call: TurnEngineCall }
  | { type: "tool_result"; round: number; call: TurnEngineCall; result: ToolResult }
  | { type: "intervention"; round: number; messages: Message[] }
  | { type: "final"; round: number; response: ProviderResponse };

export interface ProviderToolLoopResult {
  response: ProviderResponse;
  messages: Message[];
  rounds: number;
  toolCallCount: number;
}

export async function runProviderToolLoop(input: ProviderToolLoopInput): Promise<ProviderToolLoopResult> {
  const maxRounds = input.maxRounds ?? 6;
  const messages = [...input.messages];
  const allowedToolNames = input.tools.map((tool) => tool.name);
  const allowedToolNameSet = new Set(allowedToolNames);
  const maxRequirementRetries = input.maxToolUseRequirementRetries ?? 1;
  let requirementRetries = 0;
  let totalToolCalls = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const queued = input.drainQueuedMessages?.() ?? [];
    if (queued.length > 0) {
      messages.push(...queued);
      await input.onEvent?.({ type: "intervention", round, messages: queued });
    }

    const response = await input.provider.complete({
      goal: input.goal,
      systemPrompt: input.systemPrompt,
      context: input.context,
      tools: input.tools,
      agents: input.agents,
      messages,
    });
    const toolCalls = providerResponseToolCalls(response, allowedToolNames);
    await input.onEvent?.({ type: "assistant", round, text: response.text, toolCallCount: toolCalls.length });

    if (toolCalls.length === 0) {
      if (input.requireToolUse && totalToolCalls === 0 && requirementRetries < maxRequirementRetries) {
        requirementRetries += 1;
        messages.push({
          id: id("msg"),
          role: "assistant",
          content: response.text || "No tool call requested.",
          createdAt: nowIso(),
          metadata: { providerToolLoop: true, round, toolCallCount: 0, mode: input.mode ?? "plan", toolUseRequirementMiss: true },
        });
        messages.push({
          id: id("msg"),
          role: "user",
          content: input.toolUseCorrection ?? defaultToolUseCorrection(input.goal),
          createdAt: nowIso(),
          metadata: { providerToolLoop: true, correction: "require-tool-use", round, mode: input.mode ?? "plan" },
        });
        continue;
      }
      if (input.requireToolUse && totalToolCalls === 0) {
        const blocked = blockedNoToolResponse(input.mode ?? "plan", input.goal, response.text);
        await input.onEvent?.({ type: "final", round, response: blocked });
        return { response: blocked, messages, rounds: round + 1, toolCallCount: totalToolCalls };
      }
      await input.onEvent?.({ type: "final", round, response });
      return { response, messages, rounds: round + 1, toolCallCount: totalToolCalls };
    }

    messages.push({
      id: id("msg"),
      role: "assistant",
      content: response.text || `requested ${toolCalls.length} tool call(s)`,
      createdAt: nowIso(),
      metadata: { providerToolLoop: true, round, toolCallCount: toolCalls.length, mode: input.mode ?? "plan" },
    });

    const calls: TurnEngineCall[] = toolCalls.map((toolCall) => ({ name: toolCall.name, input: toolCall.input }));
    for (const call of calls) {
      await input.onEvent?.({ type: "tool_start", round, call });
    }
    const results = await runAllowedCalls(input.engine, calls, allowedToolNameSet);
    totalToolCalls += results.length;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      const call = calls[index]!;
      const toolCall = toolCalls[index]!;
      messages.push({
        id: id("msg"),
        role: "tool",
        name: toolCall.name,
        content: result.output,
        createdAt: nowIso(),
        metadata: { callId: result.callId, ok: result.ok, round, mode: input.mode ?? "plan" },
      });
      await input.onEvent?.({ type: "tool_result", round, call, result });
    }
  }

  const fallback = fallbackResponse(input.mode ?? "plan", input.goal);
  await input.onEvent?.({ type: "final", round: maxRounds, response: fallback });
  return { response: fallback, messages, rounds: maxRounds, toolCallCount: totalToolCalls };
}

function fallbackResponse(mode: "plan" | "chat", goal: string): ProviderResponse {
  if (mode === "chat") {
    return { text: "Provider exceeded the bounded tool-use loop before returning a final answer." };
  }
  const plan: UpgradePlan = {
    goal,
    summary: "Provider exceeded the bounded planning tool-use loop before returning a plan.",
    steps: [],
    verification: [],
  };
  return { text: plan.summary, plan };
}

function blockedNoToolResponse(mode: "plan" | "chat", goal: string, lastText: string): ProviderResponse {
  const text = [
    "Task requires real tool use before completion, but the provider returned no tool calls after correction.",
    "No task completion was claimed.",
    lastText.trim() ? `Last provider text: ${lastText.trim()}` : "",
  ].filter(Boolean).join("\n");
  if (mode === "chat") return { text };
  const plan: UpgradePlan = {
    goal,
    summary: text,
    steps: [],
    verification: [],
  };
  return { text, plan };
}

function defaultToolUseCorrection(goal: string): string {
  return [
    "Crix harness correction: this user request requires real tool use before any final answer.",
    "On the next response, request the needed Crix tool calls with valid JSON arguments. Do not narrate the work as complete.",
    `User request: ${goal}`,
  ].join("\n");
}

async function runAllowedCalls(engine: TurnEngine, calls: TurnEngineCall[], allowedToolNames: Set<string>): Promise<ToolResult[]> {
  const results = new Array<ToolResult>(calls.length);
  const allowed: Array<{ call: TurnEngineCall; index: number }> = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    if (allowedToolNames.has(call.name)) {
      allowed.push({ call, index });
    } else {
      results[index] = {
        callId: id(`tool_${call.name}`),
        ok: false,
        output: `tool ${call.name} is not available in this turn and was rejected before execution`,
        metadata: { rejected: true, reason: "unknown-or-out-of-scope-tool" },
      };
    }
  }
  const allowedResults = await engine.runCalls(allowed.map((item) => item.call));
  for (let index = 0; index < allowed.length; index += 1) {
    results[allowed[index]!.index] = allowedResults[index]!;
  }
  return results;
}
