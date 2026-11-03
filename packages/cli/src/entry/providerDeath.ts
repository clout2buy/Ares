// Which provider deaths retire a family for a while, and how each is said
// to the owner in plain words.
//
// Field logs, Sep 20 - Nov 2: 63 owner turns ended with zero model calls and
// nothing on screen that said why. 38 of them were Anthropic's 400 "You're
// out of extra usage": the ladder rescued each turn, but the pin was restored
// next turn and died again 0.7s later, every message, all day (31x in one
// session). An exhausted plan is no more likely to work on the next message
// than a revoked key, so it retires the family exactly like a dead key: skip
// straight to the backup rung, one note, re-probe after the cooldown.

import { isQuotaOrBillingError } from "./sessionFactory.js";

/** Auth death: a key or sign-in the provider refused. */
export function isAuthDeath(blob: string): boolean {
  return /\b402\b|\b401\b|\b403\b|insufficient.?balance|unauthorized|forbidden|invalid.?api.?key|no_auth/i.test(blob);
}

/** Usage death: the plan, extra usage, credit or quota is used up. */
export function isUsageDeath(blob: string): boolean {
  return isQuotaOrBillingError(blob);
}

/** A death that retires the provider family for the cooldown. */
export function isRetiringProviderDeath(blob: string): boolean {
  return isAuthDeath(blob) || isUsageDeath(blob);
}

const DISPLAY: Record<string, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  kimi: "Kimi",
  ares: "Your Ares account",
};

export function providerDisplayName(family: string): string {
  return DISPLAY[family] ?? family;
}

/** "Claude says your plan's extra usage is out" — the owner-facing reason for a usage death. */
export function describeUsageDeath(family: string, fatal: string): string {
  const who = providerDisplayName(family);
  const blob = fatal.toLowerCase();
  if (/extra usage/.test(blob)) return `${who} says your plan's extra usage is out`;
  if (/plan_limit|limit is used up/.test(blob)) {
    // planLimitStop already wrote the full sentence (which window, when it resets).
    const sentence = fatal.replace(/^plan_limit:\s*/i, "").split(/(?<=\.)\s/)[0]?.replace(/\.$/, "");
    return `${who} says ${sentence ? sentence.charAt(0).toLowerCase() + sentence.slice(1) : "your plan's limit is used up"}`;
  }
  if (/credit balance|insufficient|out.?of.?balance|payment required|\b402\b/.test(blob)) return `${who} says the account is out of credit`;
  return `${who} says your usage or quota is used up`;
}

/** The one plain line for a turn that ends with nothing from any model. */
export function noReplyNotice(reason: string): string {
  const why = reason.replace(/\s+/g, " ").trim();
  const short = why.length > 220 ? `${why.slice(0, 217)}…` : why;
  return `No brain could answer: ${short || "the model never replied"}. Your message is back in the draft — press send to try again, or pick another model under the input bar.`;
}
