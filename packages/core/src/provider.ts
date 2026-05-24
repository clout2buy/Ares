import { readFile } from "node:fs/promises";
import type { AgentDefinition, ProviderRequest, ProviderResponse, ToolDefinition, UpgradePlan } from "@crix/protocol";
import { parseUpgradePlan } from "@crix/protocol";
import { OllamaCloudClient } from "./ollamaCloud.js";
import { OpenAIResponsesClient } from "./openaiResponses.js";
import { buildRolePrompt } from "./promptPack.js";
import { parseProviderJsonResponse } from "./providerResponse.js";
import { CRIX_TOOL_CATALOG } from "./toolCatalog.js";

export interface ModelProvider {
  readonly kind: string;
  complete(request: ProviderRequest, options?: ModelProviderOptions): Promise<ProviderResponse>;
}

export interface ModelProviderOptions {
  signal?: AbortSignal;
}

export class MockProvider implements ModelProvider {
  readonly kind = "mock";
  async complete(request: ProviderRequest, options: ModelProviderOptions = {}): Promise<ProviderResponse> {
    throwIfAborted(options.signal);
    if (request.systemPrompt.includes("subagent inside Crix")) {
      const toolNames = request.tools.map((tool) => tool.name);
      return {
        text: `Mock subagent completed without a configured model provider. Scoped tools available: ${toolNames.join(", ") || "none"}. Configure OpenAI/Ollama for substantive agent work.`,
      };
    }
    const plan: UpgradePlan = {
      goal: request.goal,
      summary: "Mock provider produced a verification-only plan. Configure OpenAI/Ollama or pass a plan file for edits.",
      steps: [],
      verification: [{ program: "pnpm", args: ["test"], timeoutMs: 120_000 }],
    };
    return { text: plan.summary, plan };
  }
}

export class PlanFileProvider implements ModelProvider {
  readonly kind = "plan-file";
  constructor(private readonly file: string) {}
  async complete(_request: ProviderRequest, options: ModelProviderOptions = {}): Promise<ProviderResponse> {
    throwIfAborted(options.signal);
    const raw = await readFile(this.file, "utf8");
    const plan = parseUpgradePlan(JSON.parse(raw.trimStart().replace(/^\uFEFF/, "")));
    return { text: plan.summary, plan };
  }
}

export class OpenAIOAuthProvider implements ModelProvider {
  readonly kind = "openai-oauth";
  constructor(private readonly client = new OpenAIResponsesClient()) {}
  async complete(request: ProviderRequest, options: ModelProviderOptions = {}): Promise<ProviderResponse> {
    if (isSubagentRequest(request)) {
      return parseTextProviderResponse(await this.client.completeText(renderProviderTextRequest(request), request.systemPrompt, { signal: options.signal }));
    }
    return await this.client.createUpgradePlan(request, { signal: options.signal });
  }
}

export class OllamaCloudProvider implements ModelProvider {
  readonly kind = "ollama-cloud";
  constructor(private readonly client = new OllamaCloudClient()) {}
  async complete(request: ProviderRequest, options: ModelProviderOptions = {}): Promise<ProviderResponse> {
    if (isSubagentRequest(request)) {
      return parseTextProviderResponse(await this.client.completeText(renderProviderTextRequest(request), request.systemPrompt, { signal: options.signal }));
    }
    return await this.client.createUpgradePlan(request, { signal: options.signal });
  }
}

export class ProviderRouter {
  constructor(private readonly provider: ModelProvider = new MockProvider()) {}
  complete(request: ProviderRequest, options?: ModelProviderOptions): Promise<ProviderResponse> {
    return this.provider.complete(request, options);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error(signal.reason instanceof Error ? signal.reason.message : "provider request aborted");
}

function isSubagentRequest(request: ProviderRequest): boolean {
  return request.systemPrompt.includes("subagent inside Crix");
}

function parseTextProviderResponse(text: string): ProviderResponse {
  try {
    return parseProviderJsonResponse(text);
  } catch {
    return { text };
  }
}

function renderProviderTextRequest(request: ProviderRequest): string {
  const files = request.context.files
    .slice(0, 12)
    .map((file) => `- ${file.path}: ${file.summary}`)
    .join("\n");
  const memories = request.context.memories
    .slice(0, 8)
    .map((memory) => `- ${memory.text}`)
    .join("\n");
  const messages = request.messages
    .slice(-10)
    .map((message) => `${message.role}${message.name ? `(${message.name})` : ""}: ${message.content}`)
    .join("\n");
  const tools = request.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  return [
    `Goal:\n${request.goal}`,
    files ? `Relevant files:\n${files}` : "",
    memories ? `Memories:\n${memories}` : "",
    messages ? `Conversation:\n${messages}` : "",
    tools ? `Available role tools:\n${tools}` : "",
    tools ? "If you need one or more available role tools before answering, return only valid JSON shaped as {\"text\":\"why the tool is needed\",\"toolCalls\":[{\"id\":\"call_1\",\"name\":\"read_file\",\"input\":{\"path\":\"README.md\"}}]}." : "",
    "Return the role result directly. Include findings, evidence, verification performed, and blockers. Do not return an UpgradePlan JSON object unless explicitly asked.",
  ].filter(Boolean).join("\n\n");
}

export function defaultAgents(): AgentDefinition[] {
  const agents: Omit<AgentDefinition, "systemPrompt">[] = [
    { id: "architect", name: "Architect", description: "Designs scoped implementation plans, phases, tool gaps, and module boundaries.", tools: ["read_file", "grep_search", "tasklist_add", "remember"], maxTurns: 4 },
    { id: "coder", name: "Coder", description: "Implements isolated code changes with checkpointing and tests.", tools: ["read_file", "write_file", "replace_text", "multi_edit", "run_verification"], maxTurns: 6 },
    { id: "reviewer", name: "Reviewer", description: "Finds correctness, safety, regression, and missing-test gaps.", tools: ["read_file", "grep_search", "diagnostics", "run_verification"], maxTurns: 4 },
    { id: "researcher", name: "Researcher", description: "Maps codebases and extracts relevant context without editing.", tools: ["read_file", "read_partial_file", "grep_search", "codebase_retrieval", "memory_search"], maxTurns: 4 },
    { id: "toolsmith", name: "Toolsmith", description: "Designs and implements missing Crix tool-catalog capabilities.", tools: ["read_file", "grep_search", "write_file", "replace_text", "run_verification"], maxTurns: 6 },
    { id: "qa", name: "QA", description: "Runs verification, diagnostics, process checks, and browser/runtime smoke plans.", tools: ["run_verification", "diagnostics", "launch_process", "browser_snapshot"], maxTurns: 4 },
  ];
  return agents.map((agent) => ({ ...agent, systemPrompt: buildRolePrompt(agent) }));
}

export function defaultTools(): ToolDefinition[] {
  return CRIX_TOOL_CATALOG;
}


