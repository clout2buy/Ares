// The ORSI door, from Ares's side.
//
// ORSI (Oricle Recursive Self-Improvement) lives on doingbox and is reached
// through a small token-gated HTTP door. Ares plugs in as one agent among
// many: it declares its one evolvable gene (orsiOverlay.ts), reports its real
// turns so the loop sees where it fails, runs the loop's sandbox jobs on
// request, and reads back the evolved text. Everything here is best-effort
// and env-gated — no ORSI_DOOR/ORSI_TOKEN means every call is a no-op and the
// garrison never knows the difference.
//
//   ORSI_DOOR    https://orsi.mistiqueai.com
//   ORSI_TOKEN   the token the door's owner minted for "ares"
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TodoStore, ShellRegistry } from "@ares/tools";
import { Session } from "@ares/core";
import { buildCodingTools } from "./engineTools.js";
import { AresCommandPermissionStore, AresPathPermissionStore } from "./permissions.js";
import { selectProvider, type ProviderSelection } from "./providers.js";
import { AresRuntimeState, cliRuntimeContext } from "./runtime.js";
import { buildSystemPrompt } from "./turnPipeline.js";
import { DEFAULT_RULES, GENE, genomePath, type OrsiGenomeFile } from "./orsiOverlay.js";

const run = promisify(execFile);

export interface DoorConfig {
  door: string;
  token: string;
}

/** The door every Ares joins unless told otherwise. */
export const DEFAULT_DOOR = "https://orsi.mistiqueai.com";
export const FLEET = "ares";

/** <home>/orsi.json — written by `join`, the install's membership of the fleet. */
export interface OrsiMembership {
  door: string;
  token: string;
  agent: string;
  fleet: string;
  install_id: string;
  joined_at: string;
  /** The owner said yes to what leaves the machine. Nothing runs without it. */
  consent: true;
}

export function membershipPath(home: string): string {
  return path.join(home, "orsi.json");
}

export function readMembership(home: string): OrsiMembership | null {
  try {
    const m = JSON.parse(fs.readFileSync(membershipPath(home), "utf8")) as OrsiMembership;
    return m && m.consent === true && m.door && m.token ? m : null;
  } catch {
    return null;
  }
}

/** Env wins (a manually minted token); otherwise the install's membership file. */
export function doorConfig(env: NodeJS.ProcessEnv = process.env, home?: string): DoorConfig | null {
  const door = (env.ORSI_DOOR ?? "").replace(/\/+$/, "");
  const token = env.ORSI_TOKEN ?? "";
  if (door && token) return { door, token };
  if (!home) return null;
  const m = readMembership(home);
  return m ? { door: m.door.replace(/\/+$/, ""), token: m.token } : null;
}

/** What the owner is agreeing to. Shown before `join`; the UI shows the same text. */
export const CONSENT_TEXT = [
  "Ares can get better over time by joining ORSI, the improvement loop on the Ares network.",
  "If you say yes, Ares will: report each turn's prompt, reply, tool calls and outcome (keys and tokens scrubbed);",
  "run short practice tasks in throwaway folders when the loop asks; and use the operating rules the loop proves.",
  "Nothing else leaves this machine. You can leave any time: `ares orsi leave`.",
].join("\n");

/** Enrol this install in the fleet: mint its token, declare the gene, fetch the genome. Idempotent per install id. */
export async function join(home: string, door = process.env.ORSI_DOOR || DEFAULT_DOOR, version = "unknown"): Promise<OrsiMembership> {
  const existing = readMembership(home);
  const install_id = existing?.install_id ?? `ares-${randomUUID()}`;
  const res = await fetch(`${door.replace(/\/+$/, "")}/v1/enrol`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "ares-orsi/1" },
    body: JSON.stringify({ fleet: FLEET, install_id, version, info: { agent: "ares", os: process.platform } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; agent?: string; token?: string; fleet?: string; error?: string };
  if (res.status !== 200 || !body.token || !body.agent) throw new Error(`enrol failed: ${res.status} ${body.error ?? ""}`);
  const m: OrsiMembership = { door: door.replace(/\/+$/, ""), token: body.token, agent: body.agent, fleet: body.fleet ?? FLEET,
    install_id, joined_at: new Date().toISOString(), consent: true };
  await mkdir(home, { recursive: true });
  await writeFile(`${membershipPath(home)}.tmp`, JSON.stringify(m, null, 1), { mode: 0o600 });
  await rename(`${membershipPath(home)}.tmp`, membershipPath(home));
  const cfg = { door: m.door, token: m.token };
  await register(cfg, `ares-${version}`);
  await refreshGenome(cfg, home).catch(() => null);
  return m;
}

export async function leave(home: string): Promise<boolean> {
  try {
    await rm(membershipPath(home), { force: true });
    await rm(genomePath(home), { force: true });
    return true;
  } catch {
    return false;
  }
}

async function call<T = unknown>(cfg: DoorConfig, method: string, route: string, body?: unknown, timeoutMs = 20_000): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${cfg.door}${route}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", "User-Agent": "ares-orsi/1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 204) return { status: 204, body: null };
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch {
    return { status: res.status, body: null };
  }
}

// ── genome ────────────────────────────────────────────────────────────────
/** Fetch the evolved overlay and persist it where orsiOverlay reads it. Returns the file written, or null. */
export async function refreshGenome(cfg: DoorConfig, home: string): Promise<OrsiGenomeFile | null> {
  const { status, body } = await call<OrsiGenomeFile>(cfg, "GET", "/v1/genome");
  if (status !== 200 || !body) return null;
  const file: OrsiGenomeFile = { ...body, fetched_at: new Date().toISOString() };
  const target = genomePath(home);
  let previous: OrsiGenomeFile | null = null;
  try {
    previous = JSON.parse(await readFile(target, "utf8")) as OrsiGenomeFile;
  } catch {
    previous = null;
  }
  await writeFile(`${target}.tmp`, JSON.stringify(file, null, 1), "utf8");
  await rename(`${target}.tmp`, target);
  if (previous && previous.version !== file.version && file.genome?.[GENE]) {
    for (const fn of learnedListeners) fn({ version: file.version ?? "", proposal: file.proposal ?? null, rules: file.genome[GENE] });
  }
  return file;
}

export interface Learned { version: string; proposal: string | null; rules: string }
const learnedListeners = new Set<(l: Learned) => void>();
/** Hear it when a new genome lands: that is the "Ares just learned" moment. */
export function onLearned(fn: (l: Learned) => void): () => void {
  learnedListeners.add(fn);
  return () => learnedListeners.delete(fn);
}

let lastRefresh = 0;
/** Called on the turn path: refresh at most once a minute, never block, never throw. */
export function refreshGenomeSoon(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const cfg = doorConfig(env, home);
  if (!cfg) return;
  const now = Date.now();
  if (now - lastRefresh < 60_000) return;
  lastRefresh = now;
  void refreshGenome(cfg, home).catch(() => null);
}

// ── register ──────────────────────────────────────────────────────────────
export async function register(cfg: DoorConfig, fingerprint: string): Promise<unknown> {
  const { status, body } = await call(cfg, "POST", "/v1/register", {
    genes: { [GENE]: DEFAULT_RULES },
    gene_limits: { [GENE]: 1500 },
    fingerprint,
    info: { agent: "ares", surface: "garrison" },
  });
  if (status !== 200) throw new Error(`register failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

// ── turns ─────────────────────────────────────────────────────────────────
export type TraceRow = { call: string; args: unknown } | { result: unknown };

export interface ReportedTurn {
  id?: string;
  prompt: string;
  reply: string;
  trace: TraceRow[];
  status: string;
  owner?: "up" | "down";
  note?: string;
  tokens?: number;
}

export interface TurnVerdict { findings: Array<{ kind: string; call?: string; detail: string }>; fresh: number; cycle_started: boolean }

/** Fire-and-forget: a reported turn must never slow or break the turn it describes. `onVerdict` hears what the
 *  door saw in it (the named failures), for the UI. */
export function reportTurn(turn: ReportedTurn, env: NodeJS.ProcessEnv = process.env, home?: string, onVerdict?: (v: TurnVerdict) => void): void {
  const cfg = doorConfig(env, home);
  if (!cfg) return;
  void call<TurnVerdict>(cfg, "POST", "/v1/turns", { ...turn, trace: turn.trace.slice(-400) }, 10_000)
    .then((r) => { if (r.status === 200 && r.body && onVerdict) onVerdict(r.body); })
    .catch(() => null);
}

/** Collects one live turn from engine events into a door report. */
export class TurnCollector {
  private trace: TraceRow[] = [];
  private names = new Map<string, string>();
  reply = "";
  status = "";
  tokens = 0;
  constructor(readonly prompt: string) {}
  observe(ev: Record<string, unknown>): void {
    const type = ev.type as string;
    if (type === "tool_start") {
      this.names.set(String(ev.id), String(ev.name));
      this.trace.push({ call: String(ev.name), args: clip(ev.input) });
    } else if (type === "tool_end") {
      this.trace.push({ result: clip(ev.output) });
    } else if (type === "tool_error") {
      this.trace.push({ result: `error: ${String(ev.error ?? "")}`.slice(0, 400) });
    } else if (type === "text_delta") {
      if (this.reply.length < 8000) this.reply += String(ev.text ?? "");
    } else if (type === "turn_end") {
      this.status = String(ev.status ?? "");
      const usage = ev.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      this.tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    }
  }
  report(): ReportedTurn {
    return { prompt: this.prompt.slice(0, 2000), reply: this.reply, trace: this.trace, status: this.status, tokens: this.tokens };
  }
}

function clip(v: unknown, n = 400): unknown {
  if (typeof v === "string") return v.slice(0, n);
  try {
    const s = JSON.stringify(v);
    return s.length > n ? s.slice(0, n) : v;
  } catch {
    return String(v).slice(0, n);
  }
}

// ── jobs: a sandboxed Ares turn for ORSI ──────────────────────────────────
export interface DoorJob {
  id: string;
  task: { id: string; prompt: string; calls?: number };
  genome: Record<string, string>;
  files?: string;
  timeout_s?: number;
}

export interface JobResult {
  reply: string;
  trace: TraceRow[];
  tokens: number;
  error: string;
  files: string;
}

async function unpackTo(b64: string, dir: string): Promise<void> {
  if (!b64) return;
  const tgz = path.join(dir, "..", `${path.basename(dir)}.tgz`);
  await writeFile(tgz, Buffer.from(b64, "base64"));
  // --no-same-owner / no absolute names: GNU tar refuses "../" members by default.
  await run("tar", ["-xzf", tgz, "-C", dir, "--no-same-owner", "--no-overwrite-dir"]);
  await rm(tgz, { force: true });
}

async function packFrom(dir: string): Promise<string> {
  const tgz = path.join(dir, "..", `${path.basename(dir)}-out.tgz`);
  await run("tar", ["-czf", tgz, "-C", dir, "."]);
  const data = await readFile(tgz);
  await rm(tgz, { force: true });
  return data.toString("base64");
}

/** Run one door job: Ares's real tools and provider, the job's genome as the rules block, a throwaway workspace. */
export async function runJob(job: DoorJob, opts: { selection?: ProviderSelection; signal?: AbortSignal } = {}): Promise<JobResult> {
  const selection = opts.selection ?? await selectProvider(new Map());
  const workspace = await mkdtemp(path.join(os.tmpdir(), `ares-orsi-job-${job.id}-`));
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-orsi-home-"));
  const result: JobResult = { reply: "", trace: [], tokens: 0, error: "", files: "" };
  const shellRegistry = new ShellRegistry();
  // The task's files live under work/ (tasks say "work/x.txt"); the agent runs with the workspace as cwd, exactly
  // like the Python client. Only work/ goes back: that is what the graders read.
  const work = path.join(workspace, "work");
  try {
    await mkdir(work, { recursive: true });
    await unpackTo(job.files ?? "", work);
    const context = cliRuntimeContext({ workspace, home });
    const runtime: AresRuntimeState = { permissionMode: "workspace-write" };
    const [pathPermissions, commandPermissions] = await Promise.all([
      AresPathPermissionStore.load(context),
      AresCommandPermissionStore.load(context),
    ]);
    const tools = await buildCodingTools(pathPermissions, commandPermissions, selection, runtime, context, shellRegistry, new TodoStore(), new Map(), { shell: true });
    const rules = job.genome?.[GENE] ?? DEFAULT_RULES;
    const session = new Session({
      provider: selection.provider,
      model: selection.model,
      systemPrompt: buildSystemPrompt("workspace-write", context, { rules }),
      tools,
      workspace,
      signal: opts.signal,
      sessionId: `orsi_${job.id}`,
      maxTurns: job.task.calls ?? 16,
    });
    const collector = new TurnCollector(job.task.prompt);
    const deadline = AbortSignal.timeout(((job.timeout_s ?? 240) + 30) * 1000);
    for await (const event of session.send(job.task.prompt)) {
      if (deadline.aborted) {
        result.error = "job timed out";
        break;
      }
      collector.observe(event as Record<string, unknown>);
      if ((event as { type?: string }).type === "error" && !result.error) {
        result.error = String((event as { error?: { message?: string } }).error?.message ?? "error").slice(0, 300);
      }
    }
    const r = collector.report();
    result.reply = r.reply;
    result.trace = r.trace;
    result.tokens = r.tokens ?? 0;
  } catch (err) {
    result.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  } finally {
    await shellRegistry.killAll().catch(() => 0);
    try {
      result.files = await packFrom(work);
    } catch (err) {
      result.error ||= `could not pack workspace: ${err instanceof Error ? err.message : String(err)}`;
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

/** The worker: pull jobs forever, run them, post results. Also keeps the genome fresh. */
export async function work(cfg: DoorConfig, home: string, log: (line: string) => void = console.log, signal?: AbortSignal): Promise<void> {
  log(`ares orsi worker → ${cfg.door}`);
  const selection = await selectProvider(new Map());
  log(`provider ${selection.provider.name}/${selection.model}`);
  let idle = 0;
  while (!signal?.aborted) {
    let job: DoorJob | null = null;
    try {
      const r = await call<DoorJob>(cfg, "GET", "/v1/jobs/next");
      job = r.status === 200 ? r.body : null;
      if (++idle % 20 === 0) await refreshGenome(cfg, home).catch(() => null);
    } catch (err) {
      log(`door unreachable: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(15_000, signal);
      continue;
    }
    if (!job) {
      await sleep(3_000, signal);
      continue;
    }
    const t0 = Date.now();
    const res = await runJob(job, { selection, signal });
    try {
      await call(cfg, "POST", `/v1/jobs/${job.id}`, res, 120_000);
      log(`job ${job.id} (${job.task.id}): ${res.reply.length} chars, ${res.trace.length} trace rows, ${Math.round((Date.now() - t0) / 1000)}s${res.error ? `, error: ${res.error}` : ""}`);
    } catch (err) {
      log(`could not post result for ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function status(cfg: DoorConfig): Promise<unknown> {
  return (await call(cfg, "GET", "/v1/status")).body;
}

/** The worker inside a running Ares: one job at a time, events out for the UI. Returns a stop function. */
export function startWorker(home: string, emit: (ev: Record<string, unknown>) => void, env: NodeJS.ProcessEnv = process.env): () => void {
  const ac = new AbortController();
  const cfg = doorConfig(env, home);
  if (!cfg) return () => undefined;
  void (async () => {
    let selection: ProviderSelection | null = null;
    while (!ac.signal.aborted) {
      let job: DoorJob | null = null;
      try {
        const r = await call<DoorJob>(cfg, "GET", "/v1/jobs/next");
        job = r.status === 200 ? r.body : null;
      } catch {
        await sleep(20_000, ac.signal);
        continue;
      }
      if (!job) {
        await sleep(4_000, ac.signal);
        continue;
      }
      emit({ type: "orsi_job", phase: "start", job: job.id, task: job.task.id });
      const t0 = Date.now();
      try {
        selection ??= await selectProvider(new Map());
        const res = await runJob(job, { selection, signal: ac.signal });
        await call(cfg, "POST", `/v1/jobs/${job.id}`, res, 120_000);
        emit({ type: "orsi_job", phase: "end", job: job.id, task: job.task.id, seconds: Math.round((Date.now() - t0) / 1000), error: res.error || null });
      } catch (err) {
        emit({ type: "orsi_job", phase: "end", job: job.id, task: job.task.id, seconds: Math.round((Date.now() - t0) / 1000), error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
    }
  })();
  return () => ac.abort();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
