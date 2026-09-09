// Account usage as each provider reports it, in one shape the UI can draw:
// rolling windows as a fraction, when they reset, the plan name, and billed
// extra. Providers with no usage endpoint fall back to Ares's own token
// ledger in the daemon, not here.
import { fetchOllamaUsage, type OllamaUsage } from "./ollamaCloud.js";

export interface UsageWindow {
  /** "5-hour limit", "Weekly · all models", "Session", "Weekly" … */
  label: string;
  /** 0..1 */
  utilization: number;
  resetsAt?: string;
}

export interface ProviderUsage {
  provider: string;
  label: string;
  plan?: string;
  windows: UsageWindow[];
  extra?: { cost: number; currency?: string; note?: string };
  models?: Array<{ name: string; requestCount: number }>;
  fetchedAt: string;
  /** Where the numbers come from, for the tooltip. */
  source: string;
}

interface AnthropicWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** https://api.anthropic.com/api/oauth/usage — the same figures Claude
 *  Desktop's "Plan usage limits" card draws. Needs the user:profile scope. */
export async function fetchAnthropicUsage(accessToken: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<ProviderUsage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" };
  const signal = () => AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const [usageRes, profileRes] = await Promise.all([
    fetchImpl("https://api.anthropic.com/api/oauth/usage", { headers, signal: signal() }),
    fetchImpl("https://api.anthropic.com/api/oauth/profile", { headers, signal: signal() }).catch(() => null),
  ]);
  if (usageRes.status === 401 || usageRes.status === 403) throw new Error("Claude sign-in expired — sign in again");
  if (!usageRes.ok) throw new Error(`Claude usage: HTTP ${usageRes.status}`);
  const raw = (await usageRes.json()) as Record<string, AnthropicWindow | null | undefined> & {
    extra_usage?: { is_enabled?: boolean; used_credits?: number | null; monthly_limit?: number | null; currency?: string | null; utilization?: number | null } | null;
  };
  const profile = profileRes && profileRes.ok
    ? ((await profileRes.json().catch(() => null)) as { account?: { has_claude_max?: boolean; has_claude_pro?: boolean }; organization?: { rate_limit_tier?: string; organization_type?: string } } | null)
    : null;
  const frac = (w: AnthropicWindow | null | undefined): number | null =>
    w && typeof w.utilization === "number" && Number.isFinite(w.utilization) ? Math.min(1, Math.max(0, w.utilization / 100)) : null;
  const windows: UsageWindow[] = [];
  const push = (label: string, w: AnthropicWindow | null | undefined) => {
    const u = frac(w);
    if (u === null) return;
    windows.push({ label, utilization: u, ...(w?.resets_at ? { resetsAt: w.resets_at } : {}) });
  };
  push("5-hour limit", raw.five_hour);
  push("Weekly · all models", raw.seven_day);
  push("Weekly · Opus", raw.seven_day_opus);
  push("Weekly · Sonnet", raw.seven_day_sonnet);
  const tier = profile?.organization?.rate_limit_tier ?? "";
  const mult = /(\d+)x/.exec(tier)?.[1];
  const plan = profile?.account?.has_claude_max ? `Max${mult ? ` (${mult}x)` : ""}` : profile?.account?.has_claude_pro ? "Pro" : profile?.organization?.organization_type ?? undefined;
  const extra = raw.extra_usage && raw.extra_usage.is_enabled && typeof raw.extra_usage.used_credits === "number"
    ? { cost: raw.extra_usage.used_credits, ...(raw.extra_usage.currency ? { currency: raw.extra_usage.currency } : {}), note: "extra usage this month" }
    : undefined;
  return {
    provider: "anthropic",
    label: "Claude",
    ...(plan ? { plan } : {}),
    windows,
    ...(extra ? { extra } : {}),
    fetchedAt: new Date().toISOString(),
    source: "api.anthropic.com/api/oauth/usage",
  };
}

export function ollamaUsageAsProvider(u: OllamaUsage): ProviderUsage {
  return {
    provider: "ollama",
    label: "Ollama Cloud",
    windows: [
      { label: "Session", utilization: u.session.usage },
      { label: "Weekly", utilization: u.weekly.usage },
    ],
    ...(u.extra.cost > 0 ? { extra: { cost: u.extra.cost, currency: "USD", note: "billed outside the plan · 4 weeks" } } : {}),
    models: u.weekly.models.slice(0, 6).map((m) => ({ name: m.name, requestCount: m.requestCount })),
    fetchedAt: u.fetchedAt,
    source: "ollama.com/api/usage",
  };
}

export async function fetchOllamaUsageAsProvider(apiKey: string): Promise<ProviderUsage> {
  return ollamaUsageAsProvider(await fetchOllamaUsage(apiKey));
}

interface KimiWindow { window?: { duration?: number; timeUnit?: string }; detail?: { limit?: string | number; used?: string | number; remaining?: string | number; resetTime?: string } }

/** https://api.kimi.com/coding/v1/usages — the Kimi Code subscription's
 *  rolling windows (a 5-hour window under `limits`, the longer cycle under
 *  `usage`), membership level, and the booster wallet. */
export async function fetchKimiUsage(accessToken: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<ProviderUsage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl("https://api.kimi.com/coding/v1/usages", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Kimi sign-in expired — sign in again");
  if (!res.ok) throw new Error(`Kimi usage: HTTP ${res.status}`);
  const raw = (await res.json()) as {
    user?: { membership?: { level?: string } };
    usage?: { limit?: string | number; remaining?: string | number; resetTime?: string };
    limits?: KimiWindow[];
    boosterWallet?: { balance?: { amount?: string | number; amountLeft?: string | number }; monthlyUsed?: { currency?: string; priceInCents?: string | number } };
  };
  const num = (v: unknown): number => { const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) ? n : 0; };
  const windows: UsageWindow[] = [];
  for (const w of raw.limits ?? []) {
    const limit = num(w.detail?.limit);
    if (limit <= 0) continue;
    const used = w.detail?.used !== undefined ? num(w.detail.used) : limit - num(w.detail?.remaining);
    const minutes = w.window?.timeUnit === "TIME_UNIT_MINUTE" ? num(w.window?.duration) : w.window?.timeUnit === "TIME_UNIT_HOUR" ? num(w.window?.duration) * 60 : w.window?.timeUnit === "TIME_UNIT_DAY" ? num(w.window?.duration) * 1440 : 0;
    const label = minutes > 0 ? (minutes % 1440 === 0 ? `${minutes / 1440}-day limit` : minutes % 60 === 0 ? `${minutes / 60}-hour limit` : `${minutes}-minute limit`) : "Rolling limit";
    windows.push({ label, utilization: Math.min(1, Math.max(0, used / limit)), ...(w.detail?.resetTime ? { resetsAt: w.detail.resetTime } : {}) });
  }
  const cycleLimit = num(raw.usage?.limit);
  if (cycleLimit > 0) {
    const used = cycleLimit - num(raw.usage?.remaining);
    windows.push({ label: "Cycle", utilization: Math.min(1, Math.max(0, used / cycleLimit)), ...(raw.usage?.resetTime ? { resetsAt: raw.usage.resetTime } : {}) });
  }
  const booster = raw.boosterWallet?.balance;
  const bAmount = num(booster?.amount);
  if (bAmount > 0) windows.push({ label: "Booster wallet used", utilization: Math.min(1, Math.max(0, 1 - num(booster?.amountLeft) / bAmount)) });
  const level = raw.user?.membership?.level ?? "";
  const plan = level ? level.replace(/^LEVEL_/, "").toLowerCase().replace(/^./, (c) => c.toUpperCase()) : undefined;
  const monthlyCents = num(raw.boosterWallet?.monthlyUsed?.priceInCents);
  return {
    provider: "kimi",
    label: "Kimi Code",
    ...(plan ? { plan } : {}),
    windows,
    ...(monthlyCents > 0 ? { extra: { cost: monthlyCents / 100, currency: raw.boosterWallet?.monthlyUsed?.currency ?? "USD", note: "booster top-ups this month" } } : {}),
    fetchedAt: new Date().toISOString(),
    source: "api.kimi.com/coding/v1/usages",
  };
}
