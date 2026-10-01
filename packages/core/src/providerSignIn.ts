// Provider sign-ins as a Connect target: `Connect {service: "provider:<id>"}`.
//
// A coding agent (Claude Code, Codex, Kimi CLI) or one of Ares's own model
// logins (Anthropic, OpenAI, Kimi) is signed in through the garrison's provider
// broker (cli/phoneProviders.ts), which the phone drives in-app. The Connect
// tool only needs three things from it, so that is the whole interface: read a
// provider's state, ask for the owner's attention, and be woken when the owner
// has signed in. The tool never sees an OAuth URL, a code or a token.

export type ProviderSignInState = "signed_in" | "signed_out" | "expired" | "unknown" | "login_in_progress";

export interface ProviderSignInInfo {
  id: string;
  label: string;
  kind: "coding-agent" | "model";
  state: ProviderSignInState;
  /** An email or plan label, never a token. */
  account?: string;
  /** How the broker will sign this provider in. */
  method: "loopback" | "device" | "paste" | "key";
  note?: string;
}

export interface ProviderSignInHost {
  /** Every provider the broker knows, with live state. */
  list(): Promise<ProviderSignInInfo[]>;
  /**
   * Watch `id` until it reports signed in (or `timeoutMs` passes). On sign-in
   * the HOST wakes `sessionId` with a short note so the agent carries on, then
   * runs `onSignedIn` (the card flip). Returns at once: it must never block the
   * agent's turn. A second watch for the same (session, provider) replaces the first.
   */
  watch(id: string, opts: { sessionId: string; timeoutMs: number; onSignedIn?: (info: ProviderSignInInfo) => void; onGaveUp?: (reason: string) => void }): void;
}

let host: ProviderSignInHost | null = null;

export function setProviderSignInHost(next: ProviderSignInHost | null): void {
  host = next;
}

export function getProviderSignInHost(): ProviderSignInHost | null {
  return host;
}

/** Ids the Connect tool accepts after `provider:`. */
export const PROVIDER_SIGN_IN_IDS = ["claude-code", "codex", "kimi-cli", "ares-anthropic", "ares-openai", "ares-kimi"] as const;

/** `provider:claude-code` -> `claude-code` (also tolerant of case and a bare id); null when it is not a provider ask. */
export function providerSignInIdOf(asked: string): string | null {
  const m = /^provider:\s*([a-z0-9-]+)$/i.exec(asked.trim());
  return m ? m[1]!.toLowerCase() : null;
}
