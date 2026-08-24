// Usage aggregation for the daemon's usage_stats command: scans on-disk
// session event logs and prices tokens via live OpenRouter data.
//
// Field origin: exit-134 OOM crashes with ONE resident session. The HELM war
// room polls usage_stats every 5 seconds, and this scan used to
// `readFile(events.jsonl, "utf8")` — on a workspace carrying a 314MB event log
// (109 legacy compaction events, up to 14MB apiece) that is a ~630MB UTF-16
// string plus split() slices PER POLL, overlapping with the previous poll
// still parsing. The heap guard watched baseline climb to 3.6GB of committed
// garbage until one mid-spike allocation aborted the process.
//
// So the scan now never holds more than one line: files are read in bounded
// chunks and split on newlines. And because events.jsonl is append-only, each
// file's aggregate is cached with the byte offset it was computed through — a
// 5-second poll re-reads only the bytes appended since the last one, not half
// a gigabyte of history. Concurrent calls for the same scan coalesce onto one
// promise instead of stacking.

import path from "node:path";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { fetchOpenRouterModels } from "@ares/core";

export interface UsageStats {
  sessions: number;
  apiCalls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  auxiliaryTokensIn: number;
  auxiliaryTokensOut: number;
  daily: Array<{ date: string; in: number; out: number }>;
  models: Array<{ model: string; provider?: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
  /** Per-provider rollup (tokens, requests, estimated spend) — the DeepSeek-
   *  platform-style view. Cost is an estimate from live OpenRouter pricing
   *  where the model is listed there; undefined = unknown, 0 = local/free. */
  providers: Array<{ provider: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
}

interface ModelAgg {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  calls: number;
}

interface ProviderAgg {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  calls: number;
}

/** Running totals for ONE session file, valid through `offset` bytes of it. */
interface FileAggregate {
  apiCalls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  auxiliaryTokensIn: number;
  auxiliaryTokensOut: number;
  daily: Map<string, { in: number; out: number }>;
  models: Map<string, ModelAgg>;
  providers: Map<string, ProviderAgg>;
  counted: boolean;
}

interface FileCacheEntry {
  /** Bytes of the file already folded into `agg` (always ends on a newline). */
  offset: number;
  /** The meta.json defaults baked into the aggregate — if they change (rename,
   *  provider switch), the whole file is rescanned rather than served stale. */
  defaultModel: string;
  defaultProvider: string;
  agg: FileAggregate;
}

/** Per-events.jsonl incremental aggregates, keyed by absolute file path.
 *  Session logs are append-only, so an aggregate computed through byte N stays
 *  true forever; each scan folds in only bytes [N, size). A file that shrank
 *  (deleted + re-created id) resets. */
const fileCache = new Map<string, FileCacheEntry>();

/** One scan per (workspace, days) at a time — the HELM polls every 5s and a
 *  cold first scan of a big workspace can take longer than that. */
const inflight = new Map<string, Promise<UsageStats>>();

const READ_CHUNK_BYTES = 4 * 1024 * 1024;

function emptyAggregate(): FileAggregate {
  return {
    apiCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    auxiliaryTokensIn: 0,
    auxiliaryTokensOut: 0,
    daily: new Map(),
    models: new Map(),
    providers: new Map(),
    counted: false,
  };
}

/** Fold one rollout line into the file's aggregate. Cheap substring gates keep
 *  JSON.parse off the lines that can be huge (legacy compaction events carried
 *  multi-MB history projections); escaped occurrences inside message content
 *  can't match because their quotes are backslash-escaped. */
function foldLine(line: string, entry: FileCacheEntry): void {
  if (!line) return;
  if (!line.includes('"turn_end"') && !line.includes('"auxiliary_usage"')) return;
  let parsed: {
    ts?: string | number;
    event?: {
      type?: string;
      model?: string;
      provider?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        modelCalls?: number;
      };
    };
  };
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const ev = parsed.event;
  if ((ev?.type !== "turn_end" && ev?.type !== "auxiliary_usage") || !ev.usage) return;
  const agg = entry.agg;
  const inTok = ev.usage.inputTokens ?? 0;
  const outTok = ev.usage.outputTokens ?? 0;
  const cached = ev.usage.cacheReadTokens ?? 0;
  const calls = ev.usage.modelCalls ?? 1;
  const eventModel = ev.model || entry.defaultModel;
  // Session persistence stamps provider on turn_end/auxiliary_usage — use
  // it for a real per-provider rollup.
  const eventProvider = (ev.provider || entry.defaultProvider).toLowerCase();
  agg.apiCalls += calls;
  agg.tokensIn += inTok;
  agg.tokensOut += outTok;
  agg.cacheReadTokens += cached;
  if (ev.type === "auxiliary_usage") {
    agg.auxiliaryTokensIn += inTok;
    agg.auxiliaryTokensOut += outTok;
  }
  agg.counted = true;
  const mKey = `${eventProvider} ${eventModel}`;
  const m = agg.models.get(mKey) ?? { provider: eventProvider, model: eventModel, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
  m.tokensIn += inTok;
  m.tokensOut += outTok;
  m.cacheReadTokens += cached;
  m.calls += calls;
  agg.models.set(mKey, m);
  const p = agg.providers.get(eventProvider) ?? { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
  p.tokensIn += inTok;
  p.tokensOut += outTok;
  p.cacheReadTokens += cached;
  p.calls += calls;
  agg.providers.set(eventProvider, p);
  // Per-entry timestamp beats file mtime: a week-long session no longer
  // dumps all its tokens onto its last-touched day.
  const entryMs = parsed.ts ? new Date(parsed.ts).getTime() : NaN;
  const day = new Date(Number.isFinite(entryMs) ? entryMs : Date.now()).toISOString().slice(0, 10);
  const d = agg.daily.get(day) ?? { in: 0, out: 0 };
  d.in += inTok;
  d.out += outTok;
  agg.daily.set(day, d);
}

/** Stream bytes [entry.offset, size) in bounded chunks, folding each complete
 *  line. Never materializes the file — peak memory is one chunk plus the
 *  longest line in flight. Advances entry.offset through the last newline. */
async function foldAppendedBytes(file: string, entry: FileCacheEntry, size: number): Promise<void> {
  const handle = await open(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, size - entry.offset)));
    let pos = entry.offset;
    let remainder: Buffer | null = null;
    while (pos < size) {
      const want = Math.min(chunk.length, size - pos);
      const { bytesRead } = await handle.read(chunk, 0, want, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      // Split on newline BYTES before decoding — a chunk boundary may bisect a
      // multi-byte character, but never a '\n'.
      const data: Buffer = remainder ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let nl = data.indexOf(0x0a, start); nl !== -1; nl = data.indexOf(0x0a, start)) {
        foldLine(data.subarray(start, nl).toString("utf8").replace(/\r$/, ""), entry);
        start = nl + 1;
      }
      // Copy the tail out of the reused chunk buffer before the next read.
      remainder = start < data.length ? Buffer.from(data.subarray(start)) : null;
    }
    // A trailing line still missing its newline is a write in flight — leave
    // it for the next scan.
    entry.offset = pos - (remainder ? remainder.byteLength : 0);
  } finally {
    await handle.close();
  }
}

/** Estimate spend for a model from live OpenRouter pricing (matched by id
 *  suffix). Local ollama = $0. Returns undefined when the price is unknown. */
function estimateCostUsd(
  provider: string,
  model: string,
  usage: { tokensIn: number; tokensOut: number; cacheReadTokens: number },
  orPrices: Map<string, { input: number; output: number }>,
): number | undefined {
  if (provider === "ollama" && !model.includes("cloud")) return 0;
  if (provider === "mock") return 0;
  const bare = model.toLowerCase();
  let price = orPrices.get(bare);
  if (!price) {
    for (const [id, p] of orPrices) {
      if (id.endsWith(`/${bare}`) || bare === id.split("/").pop()) {
        price = p;
        break;
      }
    }
  }
  if (!price) return undefined;
  // Cache reads bill at roughly a tenth of input on the major providers.
  const uncachedIn = Math.max(0, usage.tokensIn - usage.cacheReadTokens);
  return (uncachedIn / 1e6) * price.input + (usage.cacheReadTokens / 1e6) * price.input * 0.1 + (usage.tokensOut / 1e6) * price.output;
}

/** Model pricing, refreshed at most every 15 minutes — this used to be one
 *  live catalog fetch per usage_stats call, i.e. one network round-trip every
 *  5 seconds while the HELM was open. Failures retry after a short cooldown. */
let orPriceCache: { at: number; prices: Map<string, { input: number; output: number }> } | null = null;
const OR_PRICE_TTL_MS = 15 * 60_000;
const OR_PRICE_RETRY_MS = 60_000;

async function openRouterPrices(): Promise<Map<string, { input: number; output: number }>> {
  const now = Date.now();
  if (orPriceCache) {
    const ttl = orPriceCache.prices.size > 0 ? OR_PRICE_TTL_MS : OR_PRICE_RETRY_MS;
    if (now - orPriceCache.at < ttl) return orPriceCache.prices;
  }
  const prices = new Map<string, { input: number; output: number }>();
  const orModels = await fetchOpenRouterModels().catch(() => []);
  for (const m of orModels) {
    if (m.promptPrice == null && m.completionPrice == null) continue;
    prices.set(m.id.toLowerCase(), { input: Number(m.promptPrice ?? 0) * 1e6, output: Number(m.completionPrice ?? 0) * 1e6 });
  }
  orPriceCache = { at: now, prices };
  return prices;
}

/** Aggregate usage across all on-disk sessions within the trailing window.
 *  Concurrent calls for the same window share one scan. */
export function daemonUsageStats(workspace: string, days: number): Promise<UsageStats> {
  const key = `${path.resolve(workspace)}|${days}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const scan = computeUsageStats(workspace, days).finally(() => inflight.delete(key));
  inflight.set(key, scan);
  return scan;
}

async function computeUsageStats(workspace: string, days: number): Promise<UsageStats> {
  const sessionsRoot = path.join(workspace, ".ares", "sessions");
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const daily = new Map<string, { in: number; out: number }>();
  const models = new Map<string, ModelAgg>();
  const providers = new Map<string, ProviderAgg>();
  let sessions = 0;
  let apiCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let auxiliaryTokensIn = 0;
  let auxiliaryTokensOut = 0;
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return {
      sessions: 0,
      apiCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      auxiliaryTokensIn: 0,
      auxiliaryTokensOut: 0,
      daily: [],
      models: [],
      providers: [],
    };
  }
  const seenFiles = new Set<string>();
  for (const dir of dirents) {
    if (!dir.isDirectory()) continue;
    const sessionDir = path.join(sessionsRoot, dir.name);
    const eventsPath = path.join(sessionDir, "events.jsonl");
    seenFiles.add(eventsPath);
    const st = await stat(eventsPath).catch(() => null);
    if (!st || st.mtimeMs < cutoff || st.size === 0) continue;
    const metaRaw = await readFile(path.join(sessionDir, "meta.json"), "utf8").catch(() => "");
    let defaultModel = "unknown";
    let defaultProvider = "unknown";
    try {
      const meta = JSON.parse(metaRaw) as { provider?: { model?: string; name?: string } };
      if (meta.provider?.model) defaultModel = meta.provider.model;
      if (meta.provider?.name) defaultProvider = meta.provider.name;
    } catch {
      /* unknown model */
    }
    let entry = fileCache.get(eventsPath);
    // Reset on truncation (session id re-used) or changed meta defaults (they
    // are baked into every cached row).
    if (!entry || entry.offset > st.size || entry.defaultModel !== defaultModel || entry.defaultProvider !== defaultProvider) {
      entry = { offset: 0, defaultModel, defaultProvider, agg: emptyAggregate() };
      fileCache.set(eventsPath, entry);
    }
    if (entry.offset < st.size) {
      await foldAppendedBytes(eventsPath, entry, st.size).catch(() => undefined);
    }
    const agg = entry.agg;
    if (!agg.counted) continue;
    sessions++;
    apiCalls += agg.apiCalls;
    tokensIn += agg.tokensIn;
    tokensOut += agg.tokensOut;
    cacheReadTokens += agg.cacheReadTokens;
    auxiliaryTokensIn += agg.auxiliaryTokensIn;
    auxiliaryTokensOut += agg.auxiliaryTokensOut;
    for (const [day, v] of agg.daily) {
      const d = daily.get(day) ?? { in: 0, out: 0 };
      d.in += v.in;
      d.out += v.out;
      daily.set(day, d);
    }
    for (const [key, v] of agg.models) {
      const m = models.get(key) ?? { provider: v.provider, model: v.model, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
      m.tokensIn += v.tokensIn;
      m.tokensOut += v.tokensOut;
      m.cacheReadTokens += v.cacheReadTokens;
      m.calls += v.calls;
      models.set(key, m);
    }
    for (const [key, v] of agg.providers) {
      const p = providers.get(key) ?? { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
      p.tokensIn += v.tokensIn;
      p.tokensOut += v.tokensOut;
      p.cacheReadTokens += v.cacheReadTokens;
      p.calls += v.calls;
      providers.set(key, p);
    }
  }
  // Deleted sessions must not keep their aggregates (or their memory) around.
  for (const cachedPath of fileCache.keys()) {
    if (cachedPath.startsWith(sessionsRoot + path.sep) && !seenFiles.has(cachedPath)) fileCache.delete(cachedPath);
  }
  // Live OpenRouter pricing turns tokens into estimated dollars where the
  // model is listed there (most frontier + open models are). A network
  // failure simply leaves cost undefined.
  const orPrices = await openRouterPrices();
  const dailyArr = [...daily.entries()].map(([date, v]) => ({ date, in: v.in, out: v.out })).sort((a, b) => a.date.localeCompare(b.date));
  const modelArr = [...models.values()]
    .map((v) => ({ ...v, costUsd: estimateCostUsd(v.provider, v.model, v, orPrices) }))
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
  const providerArr = [...providers.entries()]
    .map(([provider, v]) => {
      const providerModels = modelArr.filter((m) => m.provider === provider);
      const known = providerModels.filter((m) => m.costUsd !== undefined);
      // A provider's cost is only meaningful if every model under it priced.
      const costUsd = known.length === providerModels.length && providerModels.length > 0
        ? known.reduce((total, m) => total + (m.costUsd ?? 0), 0)
        : known.length > 0
          ? known.reduce((total, m) => total + (m.costUsd ?? 0), 0)
          : undefined;
      return { provider, ...v, costUsd };
    })
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
  return {
    sessions,
    apiCalls,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    auxiliaryTokensIn,
    auxiliaryTokensOut,
    daily: dailyArr,
    models: modelArr,
    providers: providerArr,
  };
}
