// CAPTCHA / human-verification handoff.
//
// Bots can't solve reCAPTCHA, hCaptcha, or a Cloudflare challenge — by design.
// Instead of failing the navigation (the "search got blocked" dead end), the
// browser PAUSES and hands off to a human: it surfaces the challenge URL through
// the same Gate the approval system uses, the owner solves it in their real
// (CDP-attached) browser, taps approve, and Ares resumes.
//
// detectChallenge is a PURE function of the page's surface (url + title + html),
// so it's fully unit-testable with no browser. The handler is injected by the
// composition root and adapted onto requestApproval, so connectors stays
// effects-free.

export type ChallengeKind = "recaptcha" | "hcaptcha" | "cloudflare" | "generic";

export interface ChallengeInfo {
  kind: ChallengeKind;
  url: string;
  /** Short human-readable reason for the Gate. */
  reason: string;
}

/** What the human did: solved it (re-check + continue) or skipped (give up the page). */
export type HumanCheckOutcome = "solved" | "skip";

/** Injected by the composition root; typically adapts onto requestApproval. */
export type HumanCheckHandler = (info: ChallengeInfo) => Promise<HumanCheckOutcome>;

interface ChallengeSignals {
  url: string;
  title?: string;
  /** Page HTML or body text — matched case-insensitively. */
  html?: string;
}

// Signatures, most-specific first. Cloudflare's "just a moment" interstitial,
// the two big CAPTCHA widgets, then generic "prove you're human" wording.
const RECAPTCHA = /\b(g-recaptcha|grecaptcha|recaptcha\/api|www\.google\.com\/recaptcha)\b/i;
const HCAPTCHA = /\b(h-captcha|hcaptcha\.com|js\.hcaptcha)\b/i;
const CLOUDFLARE = /(just a moment\.\.\.|checking your browser before|cf-chl-|challenge-platform|cdn-cgi\/challenge|__cf_chl)/i;
const GENERIC = /(verify you are human|are you a robot|i'm not a robot|unusual traffic from your|complete the (?:captcha|security check)|press and hold to confirm)/i;

/**
 * Inspect a page's surface and classify a human-verification wall, or null when
 * the page is clear. Order matters: a Cloudflare page often embeds a CAPTCHA
 * widget, but the actionable label is "Cloudflare challenge".
 */
export function detectChallenge(signals: ChallengeSignals): ChallengeInfo | null {
  const hay = `${signals.title ?? ""}\n${signals.html ?? ""}`;
  const mk = (kind: ChallengeKind, reason: string): ChallengeInfo => ({ kind, url: signals.url, reason });

  if (CLOUDFLARE.test(hay)) return mk("cloudflare", "Cloudflare is challenging the browser");
  if (RECAPTCHA.test(hay)) return mk("recaptcha", "A reCAPTCHA must be solved");
  if (HCAPTCHA.test(hay)) return mk("hcaptcha", "An hCaptcha must be solved");
  if (GENERIC.test(hay)) return mk("generic", "The site is asking to verify you're human");
  return null;
}

/** The Gate text shown to the owner — concrete and actionable. */
export function challengePrompt(info: ChallengeInfo): string {
  return `🧩 Human check needed — ${info.reason} at ${info.url}. Solve it in your browser, then approve to continue.`;
}

export interface ChallengeSurface {
  url: string;
  title?: string;
  html?: string;
}

export type HandoffResult = "clear" | "solved" | "skip";

/**
 * The detect → human-handoff → re-check loop, free of any browser so it's
 * unit-testable. Reads the page surface, and if a wall is up, hands off to the
 * human; on "solved" it settles and re-checks (up to maxRounds, so a stubborn
 * challenge can't loop forever); on "skip" it gives up the page.
 */
export async function runChallengeHandoff(opts: {
  getSurface: () => Promise<ChallengeSurface>;
  onChallenge: HumanCheckHandler;
  settle?: () => Promise<void>;
  maxRounds?: number;
}): Promise<HandoffResult> {
  const maxRounds = opts.maxRounds ?? 2;
  let handedOff = false;
  for (let round = 0; round < maxRounds; round++) {
    let surface: ChallengeSurface;
    try {
      surface = await opts.getSurface();
    } catch {
      return handedOff ? "solved" : "clear";
    }
    const info = detectChallenge(surface);
    if (!info) return handedOff ? "solved" : "clear";
    handedOff = true;
    const outcome = await opts.onChallenge(info).catch(() => "skip" as const);
    if (outcome === "skip") return "skip";
    await opts.settle?.();
  }
  return "solved";
}
