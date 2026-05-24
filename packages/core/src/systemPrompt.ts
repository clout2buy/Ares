import type { AgentDefinition, ToolDefinition } from "@crix/protocol";
import { renderPromptPack, renderPromptPackSummary, type PromptMode } from "./promptPack.js";

export function buildSystemPrompt(input: {
  agentName?: string;
  tools: ToolDefinition[];
  agents: AgentDefinition[];
  mode?: PromptMode;
  goal?: string;
}): string {
  return renderPromptPack(input);
}

export function buildSystemPromptSummary(input: {
  agentName?: string;
  tools: ToolDefinition[];
  agents: AgentDefinition[];
  mode?: PromptMode;
  goal?: string;
}): string {
  return renderPromptPackSummary(input);
}

export function buildChatSystemPrompt(): string {
  return [
    "You are Crix, a concise coding-agent CLI.",
    "Answer directly and keep terminal UX simple.",
    "Interactive coding requests are routed to the write-capable goal runner before chat mode.",
    "In chat-only mode, do not claim to have changed files unless a tool result proves it.",
  ].join("\n");
}
