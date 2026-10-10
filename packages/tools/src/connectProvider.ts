// Connect {service:"provider:<id>"} — ask the owner to sign in to a coding
// agent or a model provider, as a card in their app, without holding the turn.
//
// The old way was a raw OAuth link in chat plus "paste the code back". Now the
// agent only names the provider. If it is already signed in the call answers
// at once with the account; otherwise it emits ONE card (provider id, label,
// reason, method; NO url) that the app answers with its own in-app sign-in, and
// returns immediately. The garrison watches the provider and wakes this
// session when the owner is done, so nothing waits for ten minutes.

import {
  getProviderSignInHost,
  providerSignInIdOf,
  PROVIDER_SIGN_IN_IDS,
  type ProviderSignInInfo,
} from "@ares/core";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "./_shared.js";

/** How long the garrison keeps watching for the owner to finish (the broker's own flow ttl). */
export const PROVIDER_WATCH_MS = 10 * 60_000;

export interface ProviderConnectOutput {
  service?: string;
  kind?: string;
  connected?: boolean;
  pending?: boolean;
  account?: string;
  message: string;
}

export function isProviderAsk(asked: string): boolean {
  return providerSignInIdOf(asked) !== null;
}

function fail(service: string, message: string): ToolResult<ProviderConnectOutput> {
  return { output: { service, kind: "provider", connected: false, message }, display: message, failure: message };
}

export async function connectProvider(
  asked: string,
  reason: string | undefined,
  ctx: { signal: AbortSignal; sessionId?: string; emitProgress?(data: unknown): void },
): Promise<ToolResult<ProviderConnectOutput>> {
  const id = providerSignInIdOf(asked)!;
  const service = `provider:${id}`;
  if (!(PROVIDER_SIGN_IN_IDS as readonly string[]).includes(id)) {
    return fail(service, `Unknown provider "${id}". Use one of: ${PROVIDER_SIGN_IN_IDS.map((p) => `provider:${p}`).join(", ")}.`);
  }
  const host = getProviderSignInHost();
  if (!host) {
    return fail(service, "This Ares has no provider sign-in broker (it only exists on a garrison). Tell the owner to sign in from the Ares desktop app's settings. Do not print login links or ask for codes.");
  }
  let info: ProviderSignInInfo | undefined;
  try {
    info = (await host.list()).find((p) => p.id === id);
  } catch (err) {
    return fail(service, `Couldn't read the sign-in state: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!info) return fail(service, `This machine doesn't offer ${id} sign-in.`);
  if (info.state === "signed_in") {
    const message = `${info.label} is already signed in${info.account ? ` as ${info.account}` : ""}. Continue the owner's request now.`;
    return { output: { service, kind: "provider", connected: true, ...(info.account ? { account: info.account } : {}), message }, display: `${info.label} already signed in` };
  }
  if (info.state === "unknown") {
    const message = `${info.label} can't be signed in from here: ${info.note ?? "its tool is not installed on this machine"}. Tell the owner in one line; don't try to install or work around it.`;
    return fail(service, message);
  }
  const flowId = `prov_${id}_${randomUUID().slice(0, 8)}`;
  const label = info.label;
  // The card. No url, ever: the app opens its own sign-in for this provider id.
  ctx.emitProgress?.({
    kind: "connect_request",
    flowId,
    service,
    label,
    mode: "provider",
    providerId: id,
    method: info.method,
    ...(info.state === "expired" ? { expired: true } : {}),
    instructions: "Tap to sign in inside the app.",
    ...(reason ? { reason: reason.slice(0, 200) } : {}),
  });
  if (ctx.sessionId) {
    host.watch(id, {
      sessionId: ctx.sessionId,
      timeoutMs: PROVIDER_WATCH_MS,
      onSignedIn: () => {
        try { ctx.emitProgress?.({ kind: "connect_result", flowId, service, label, ok: true, detail: "Signed in." }); } catch { /* the turn that made the card is long over */ }
      },
    });
  }
  const message =
    `A ${label} sign-in card is on the owner's phone (in the Ares app). Say so in one short line, then END your turn: ` +
    "you will be woken automatically as soon as they have signed in, and nothing is blocked while they do. " +
    "Never print a login link or ask for a code or token; the app does the whole sign-in.";
  return { output: { service, kind: "provider", connected: false, pending: true, message }, display: `${label}: sign-in card sent` };
}
