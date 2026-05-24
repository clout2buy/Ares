import type { Writable } from "node:stream";
import type { AgentTurnEvent } from "@crix/protocol";

interface FrameOptions {
  provider: string;
  model?: string;
  workspace: string;
  goal: string;
}

interface TimelineRow {
  label: string;
  detail: string;
  tone: "muted" | "accent" | "ok" | "bad" | "tool" | "agent";
}

export class FullscreenTurnRenderer {
  private readonly rows: TimelineRow[] = [];
  private activeTools = 0;
  private completedTools = 0;
  private failedTools = 0;
  private grants = 0;
  private queued = 0;
  private finalText = "";
  private artifact = "";
  private entered = false;

  constructor(
    private readonly output: Pick<Writable, "write"> = process.stdout,
    private readonly options: FrameOptions,
  ) {}

  begin(): void {
    if (this.entered) return;
    this.entered = true;
    this.output.write("\x1b[?1049h\x1b[?25l");
    this.push("turn", this.options.goal, "accent");
    this.render();
  }

  event(event: AgentTurnEvent): void {
    if (!this.entered) return;
    if (event.type === "grant_added") {
      this.grants += 1;
      this.push("grant", `${event.grant.read ? "read" : ""}${event.grant.write ? "+write" : ""} ${event.grant.root}`, "accent");
    } else if (event.type === "assistant") {
      if (event.toolCallCount > 0) this.push("assistant", `requested ${event.toolCallCount} tool call${event.toolCallCount === 1 ? "" : "s"}`, "agent");
      else if (event.text.trim()) this.push("assistant", event.text, "agent");
    } else if (event.type === "tool_start") {
      this.activeTools += 1;
      this.push("tool", `${event.call.name} ${compactJson(event.call.input)}`, event.call.kind === "agent" ? "agent" : "tool");
    } else if (event.type === "tool_result") {
      this.activeTools = Math.max(0, this.activeTools - 1);
      if (event.result.ok) this.completedTools += 1;
      else this.failedTools += 1;
      this.push(event.result.ok ? "ok" : "failed", `${event.call.name}: ${summarize(event.result.output)}`, event.result.ok ? "ok" : "bad");
    } else if (event.type === "intervention") {
      this.queued += event.messages.length;
      for (const message of event.messages) this.push("queued", summarize(message.content), "accent");
    } else if (event.type === "final") {
      this.finalText = event.text;
    } else if (event.type === "error") {
      this.push("error", event.message, "bad");
    }
    this.render();
  }

  finish(finalText: string, artifact: string): void {
    if (!this.entered) return;
    this.finalText = finalText || this.finalText;
    this.artifact = artifact;
    this.render();
    this.output.write("\x1b[?25h\x1b[?1049l");
    this.entered = false;
    this.output.write(`\n${style("crix", "accent")} ${style("final", "ok")} ${summarize(this.finalText, 600)}\n`);
    if (this.artifact) this.output.write(`${style("turn", "muted")} ${this.artifact}\n`);
  }

  private push(label: string, detail: string, tone: TimelineRow["tone"]): void {
    this.rows.push({ label, detail, tone });
    while (this.rows.length > 18) this.rows.shift();
  }

  private render(): void {
    const width = Math.max(72, Math.min(120, process.stdout.columns || 100));
    const height = Math.max(24, process.stdout.rows || 32);
    const line = "─".repeat(width - 2);
    const bodyRows = Math.max(8, height - 12);
    const visible = this.rows.slice(-bodyRows);

    this.output.write("\x1b[H\x1b[2J");
    this.output.write(`${style(`╭${line}╮`, "accent")}\n`);
    this.output.write(frameLine(width, `${style("CRIX", "accent")} terminal agent runtime`, `${this.options.provider}${this.options.model ? `:${this.options.model}` : ""}`));
    this.output.write(frameLine(width, "workspace", this.options.workspace));
    this.output.write(frameLine(width, "goal", summarize(this.options.goal, width - 18)));
    this.output.write(frameLine(width, "state", `active=${this.activeTools} ok=${this.completedTools} failed=${this.failedTools} grants=${this.grants} queued=${this.queued}`));
    this.output.write(`${style(`├${line}┤`, "muted")}\n`);
    for (const row of visible) {
      this.output.write(frameLine(width, style(row.label.padEnd(10), row.tone), summarize(row.detail, width - 18)));
    }
    for (let i = visible.length; i < bodyRows; i += 1) this.output.write(frameLine(width, "", ""));
    this.output.write(`${style(`├${line}┤`, "muted")}\n`);
    this.output.write(frameLine(width, "final", summarize(this.finalText || "working", width - 18)));
    if (this.artifact) this.output.write(frameLine(width, "proof", this.artifact));
    this.output.write(`${style(`╰${line}╯`, "accent")}\n`);
  }
}

export function shouldUseFullscreen(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY && process.env.CRIX_FULLSCREEN !== "0" && process.env.NO_COLOR !== "1");
}

function frameLine(width: number, label: string, value: string): string {
  const plainLabel = stripAnsi(label).slice(0, 12);
  const contentWidth = width - 4;
  const prefix = plainLabel ? `${label}${" ".repeat(Math.max(1, 13 - plainLabel.length))}` : " ".repeat(13);
  return `${style("│", "muted")} ${fit(`${prefix}${value}`, contentWidth)} ${style("│", "muted")}\n`;
}

function compactJson(value: unknown): string {
  try {
    return summarize(JSON.stringify(value), 140);
  } catch {
    return "";
  }
}

function summarize(value: string, max = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 3))}...` : compact;
}

function fit(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return `${value}${" ".repeat(width - plain.length)}`;
  return `${plain.slice(0, Math.max(0, width - 3))}...`;
}

function style(value: string, tone: "muted" | "accent" | "ok" | "bad" | "tool" | "agent"): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return value;
  const codes = {
    muted: ["\x1b[2m", "\x1b[0m"],
    accent: ["\x1b[38;5;111m", "\x1b[0m"],
    ok: ["\x1b[38;5;120m", "\x1b[0m"],
    bad: ["\x1b[38;5;203m", "\x1b[0m"],
    tool: ["\x1b[38;5;81m", "\x1b[0m"],
    agent: ["\x1b[38;5;214m", "\x1b[0m"],
  } as const;
  const [open, close] = codes[tone];
  return `${open}${value}${close}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
