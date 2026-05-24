import path from "node:path";
import type { Writable } from "node:stream";
import type { JsonRecord, ToolResult } from "@crix/protocol";
import type { TurnEngine, TurnRecorder } from "@crix/core";

export type ToolCardKind = "tool" | "agent";

export interface ToolCardSpec {
  kind?: ToolCardKind;
  name: string;
  input: JsonRecord;
}

export interface ShellHeaderInput {
  title: string;
  provider: string;
  workspace: string;
  model?: string;
  commands?: string[];
  profile?: string;
  guidance?: string;
}

export class TuiRenderer {
  constructor(private readonly output: Pick<Writable, "write"> = process.stdout) {}

  async runToolCard(engine: TurnEngine, spec: ToolCardSpec): Promise<ToolResult> {
    const kind = spec.kind ?? "tool";
    const title = kind === "agent" && typeof spec.input.agent === "string" ? `${spec.name}:${spec.input.agent}` : spec.name;
    this.startToolCard(kind, title, spec.name, spec.input);
    const result = await engine.runCall({ kind, name: spec.name, input: spec.input }, {
      onCallStart: () => {
        this.cardRow("state", "running");
      },
      onCallComplete: ({ result, durationMs }) => {
        this.finishToolCard(spec.name, spec.input, result, durationMs);
      },
      onCallError: ({ error, durationMs }) => {
        this.failToolCard(error, durationMs);
      },
    });
    return result;
  }

  startToolCard(kind: ToolCardKind, title: string, name: string, input: JsonRecord): void {
    this.cardTop(kind, title);
    for (const line of summarizeToolInput(name, input)) this.cardRow("input", line);
    this.cardRow("state", "running");
  }

  finishToolCard(name: string, input: JsonRecord, result: ToolResult, durationMs?: number): void {
    const duration = typeof durationMs === "number" ? ` ${style(`${durationMs}ms`, "muted")}` : "";
    const summaryLines = summarizeToolResult(name, input, result);
    this.cardRow("status", `${result.ok ? style("ok", "ok") : style("failed", "bad")}${duration}`);
    for (const line of summaryLines) this.cardRow("result", line);
    this.cardBottom();
  }

  failToolCard(error: Error, durationMs?: number): void {
    const duration = typeof durationMs === "number" ? ` ${style(`${durationMs}ms`, "muted")}` : "";
    this.cardRow("status", `${style("error", "bad")}${duration}`);
    this.cardRow("result", error.message);
    this.cardBottom();
  }

  async printTurnArtifact(turn: TurnRecorder | TurnEngine, workspace: string): Promise<void> {
    const artifact = await turn.writeArtifact(workspace);
    const display = path.relative(workspace, artifact) || artifact;
    this.line(`  ${style("turn", "muted")} ${style("saved", "accent")} ${display}`);
  }

  line(text = ""): void {
    this.output.write(`${text}\n`);
  }

  shellHeader(input: ShellHeaderInput): void {
    const width = cardWidth();
    const inner = width - 4;
    this.line("");
    this.line(`  ${style(`+${"=".repeat(inner)}+`, "accent")}`);
    this.line(`  ${barLine(`${input.title}  ::  ${input.provider}${input.model ? `:${input.model}` : ""}`, inner, "brand")}`);
    this.line(`  ${barLine(`workspace  ${fit(input.workspace, inner - 11)}`, inner, "label")}`);
    if (input.profile) this.line(`  ${barLine(`mode      ${fit(input.profile, inner - 11)}`, inner, "label")}`);
    if (input.guidance) this.line(`  ${barLine(`input     ${fit(input.guidance, inner - 11)}`, inner, "muted")}`);
    else if (input.commands?.length) this.line(`  ${barLine(`input     ${input.commands.join("  ")}`, inner, "muted")}`);
    this.line(`  ${style(`+${"=".repeat(inner)}+`, "accent")}`);
    this.line("");
  }

  turnStart(goal: string, details: string[] = []): void {
    const width = cardWidth();
    this.line("");
    this.line(`  ${style(`+-- turn ${"-".repeat(Math.max(2, width - 12))}`, "accent")}`);
    this.cardRow("goal", fit(goal, width - 16));
    for (const detail of details) this.cardRow("detail", detail);
  }

  turnEnd(status: string, artifact?: string): void {
    this.cardRow("status", status);
    if (artifact) this.cardRow("turn", artifact);
    this.cardBottom();
  }

  private cardTop(kind: ToolCardKind, title: string): void {
    const width = cardWidth();
    const label = kind === "agent" ? "agent" : "tool";
    const heading = `${label} ${title}`;
    this.line("");
    this.line(`  ${style(`+-- ${fit(heading, width - 10)} `, kind === "agent" ? "agent" : "tool")}${style("-".repeat(Math.max(2, width - stripAnsi(heading).length - 7)), "muted")}`);
  }

  private cardRow(label: string, value: string): void {
    const width = cardWidth();
    const prefix = `${style("|", "muted")} ${style(label.padEnd(7), "label")} `;
    for (const line of wrap(value, width - 12)) {
      this.line(`  ${prefix}${line}`);
    }
  }

  private cardBottom(): void {
    const width = cardWidth();
    this.line(`  ${style(`+${"-".repeat(width - 3)}`, "muted")}`);
  }
}

function summarizeToolInput(name: string, input: JsonRecord): string[] {
  if (name === "write_file") return [`path=${input.path}`, `content=${String(input.content ?? "").length} chars`];
  if (name === "read_file" || name === "file_outline") return [`path=${input.path ?? "."}`];
  if (name === "glob") return [`pattern=${input.pattern}`];
  if (name === "grep_search" && input.cwd) return [`cwd=${input.cwd}`, `regex=${input.regex ?? input.query}`];
  if (name === "grep_search") return [`regex=${input.regex ?? input.query}`, `include=${input.includePattern ?? "*"}`];
  if (name === "codebase_retrieval") return [`query=${input.query}`, `max=${input.maxResults ?? 8}`];
  if (name === "tasklist_add") return [`tasks=${Array.isArray(input.tasks) ? input.tasks.length : 0}`];
  if (name === "tasklist_update") return [`task=${input.taskId}`, `status=${input.status}`];
  if (name === "memory_search") return [`query=${input.query ?? ""}`];
  if (name === "proof_report") return [`name=${input.name ?? "tool-proof"}`];
  if (name === "browser_open") return [`url=${input.url}`];
  if (name === "mcp_tools" || name === "mcp_resources") return [`server=${input.server ?? input.name ?? "inline"}`];
  if (name === "mcp_call") return [`server=${input.server ?? "inline"}`, `tool=${input.tool}`];
  if (name === "mcp_read_resource") return [`server=${input.server ?? "inline"}`, `uri=${input.uri}`];
  if (name === "run_verification") {
    const command = isRecord(input.command) ? input.command : input;
    const program = String(command.program ?? "");
    const args = Array.isArray(command.args) ? command.args.join(" ") : "";
    return [`command=${`${program} ${args}`.trim()}`];
  }
  if (name === "spawn_agent") return [`agent=${input.agent}`, `prompt=${shorten(String(input.prompt ?? ""), 90)}`];
  if (Object.keys(input).length === 0) return ["{}"];
  return [shorten(JSON.stringify(input), 140)];
}

function summarizeToolResult(name: string, input: JsonRecord, result: ToolResult): string[] {
  if (!result.ok) return [shorten(result.output, 220)];
  if (name === "tasklist_add") {
    const ids = Array.isArray(input.tasks) ? input.tasks.map((task) => isRecord(task) ? String(task.id ?? task.title ?? "task") : "task") : [];
    return [`queued ${ids.length} task${ids.length === 1 ? "" : "s"}${ids.length ? `: ${ids.join(", ")}` : ""}`];
  }
  if (name === "tasklist_update") return [`${input.taskId} -> ${input.status ?? "updated"}`];
  if (name === "write_file" || name === "replace_text" || name === "create_dir" || name === "browser_open" || name === "proof_report" || name === "run_verification") return [shorten(result.output || String(result.metadata?.command ?? "completed"), 220)];
  if (name === "read_file") {
    const rows = parseJsonArray(result.output);
    const first = isRecord(rows[0]) ? rows[0] : undefined;
    return [`verified ${first?.path ?? input.path}`, `content=${String(first?.content ?? "").length} chars`];
  }
  if (name === "list_dir") {
    const rows = parseJsonArray(result.output);
    const names = rows.slice(0, 4).map((row) => isRecord(row) ? row.path : undefined).filter(Boolean).join(", ");
    return [`${rows.length} entries${names ? `: ${names}` : ""}`];
  }
  if (name === "file_outline") {
    const rows = parseJsonArray(result.output);
    const symbols = rows.flatMap((row) => isRecord(row) && Array.isArray(row.symbols) ? row.symbols : []).length;
    return [`${rows.length} file outline${rows.length === 1 ? "" : "s"}, ${symbols} symbols`];
  }
  if (name === "grep_search" || name === "memory_search" || name === "skill_list") {
    const rows = parseJsonArray(result.output);
    return [`${rows.length} result${rows.length === 1 ? "" : "s"}`];
  }
  if (name === "glob" || name === "codebase_retrieval") {
    const rows = parseJsonArray(result.output);
    const preview = rows.slice(0, 3).map((row) => isRecord(row) ? String(row.path ?? row) : String(row)).join(", ");
    return [`${rows.length} result${rows.length === 1 ? "" : "s"}${preview ? `: ${preview}` : ""}`];
  }
  if (name === "tasklist_view") {
    const rows = parseJsonArray(result.output);
    const open = rows.filter((row) => isRecord(row) && row.status !== "completed").length;
    return [`${rows.length} task${rows.length === 1 ? "" : "s"}${open ? `, ${open} open` : ""}`];
  }
  if (name === "spawn_agent") {
    const parsed = parseJsonRecord(result.output);
    return [`${parsed.status ?? "completed"}: ${shorten(String(parsed.summary ?? ""), 180)}`];
  }
  if (name === "mcp_list") {
    const rows = parseJsonArray(result.output);
    const runnable = rows.filter((row) => isRecord(row) && typeof row.command === "string" && row.command.length > 0).length;
    return [`${rows.length} server${rows.length === 1 ? "" : "s"}, ${runnable} stdio runnable`];
  }
  if (name === "mcp_tools") {
    const parsed = parseJsonRecord(result.output);
    const tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
    return [`${tools} MCP tool${tools === 1 ? "" : "s"}`];
  }
  if (name === "mcp_resources") {
    const parsed = parseJsonRecord(result.output);
    const resources = Array.isArray(parsed.resources) ? parsed.resources.length : 0;
    return [`${resources} MCP resource${resources === 1 ? "" : "s"}`];
  }
  if (name === "mcp_call" || name === "mcp_read_resource") return [shorten(result.output, 220)];
  return [shorten(result.output, 220)];
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string): JsonRecord {
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

function shorten(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function cardWidth(): number {
  return Math.max(64, Math.min(92, process.stdout.columns || 88));
}

function fit(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 3))}...` : compact;
}

function wrap(value: string, width: number): string[] {
  const words = fit(value, 500).split(/\s+/g).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function style(value: string, tone: "muted" | "label" | "tool" | "agent" | "accent" | "ok" | "bad"): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return value;
  const codes = {
    muted: ["\x1b[2m", "\x1b[0m"],
    label: ["\x1b[38;5;245m", "\x1b[0m"],
    tool: ["\x1b[38;5;81m", "\x1b[0m"],
    agent: ["\x1b[38;5;214m", "\x1b[0m"],
    accent: ["\x1b[38;5;111m", "\x1b[0m"],
    ok: ["\x1b[38;5;120m", "\x1b[0m"],
    bad: ["\x1b[38;5;203m", "\x1b[0m"],
  } as const;
  const [open, close] = codes[tone];
  return `${open}${value}${close}`;
}

function barLine(value: string, width: number, tone: "brand" | "label" | "muted"): string {
  const content = ` ${fit(value, width - 2).padEnd(width - 2)} `;
  return `${style("|", "muted")}${style(content, tone === "brand" ? "accent" : tone)}${style("|", "muted")}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
