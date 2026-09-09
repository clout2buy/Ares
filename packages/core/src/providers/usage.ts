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
