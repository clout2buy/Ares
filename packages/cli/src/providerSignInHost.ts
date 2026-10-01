// The garrison's side of Connect {service:"provider:<id>"}: reads provider
// state from the broker (phoneProviders.ts), and when the owner signs in on
// their phone, wakes the agent session that asked, so the agent carries on
// without having held its turn for ten minutes.
//
// Two triggers, one wake: the broker tells us the instant a login finishes, and
// a slow poll catches a sign-in that happened some other way (the Providers
// screen, a CLI on the box). The wake fires once per (session, provider), only
// after the live state really reads signed_in.

import type { ProviderSignInHost, ProviderSignInInfo } from "@ares/core";

export interface ProviderSignInSource {
  list(): Promise<ProviderSignInInfo[]>;
  onSignedIn(cb: (id: string) => void): () => void;
}

export interface ProviderSignInHostOptions {
  /** Wake a session with a short note (sessions.send, queued behind any running turn). */
  wake: (sessionId: string, text: string) => Promise<void>;
  log?: (line: string) => void;
  pollMs?: number;
}

interface Watch {
  id: string;
  sessionId: string;
  onSignedIn?: (info: ProviderSignInInfo) => void;
  onGaveUp?: (reason: string) => void;
  timer: NodeJS.Timeout;
  poll: NodeJS.Timeout;
  busy: boolean;
}

export function wakeText(info: ProviderSignInInfo): string {
  return (
    `[Ares] The owner finished the ${info.label} sign-in card${info.account ? ` (signed in as ${info.account})` : ""}. ` +
    "It is connected now. Carry on with what you were doing."
  );
}

export function createProviderSignInHost(source: ProviderSignInSource, opts: ProviderSignInHostOptions): ProviderSignInHost & { close(): void } {
  const watches = new Map<string, Watch>();
  const log = (line: string): void => opts.log?.(`provider-signin: ${line}`);
  const keyOf = (sessionId: string, id: string): string => `${sessionId}\u0000${id}`;

  const stop = (key: string): Watch | undefined => {
    const w = watches.get(key);
    if (!w) return undefined;
    clearTimeout(w.timer);
    clearInterval(w.poll);
    watches.delete(key);
    return w;
  };

  const check = async (key: string): Promise<void> => {
    const w = watches.get(key);
    if (!w || w.busy) return;
    w.busy = true;
    try {
      const info = (await source.list()).find((p) => p.id === w.id);
      if (!info || info.state !== "signed_in") return;
      if (!stop(key)) return; // someone else already woke it
      log(`${w.id} signed in; waking ${w.sessionId}`);
      await opts.wake(w.sessionId, wakeText(info)).catch((err) => log(`wake failed: ${err instanceof Error ? err.message : String(err)}`));
      try { w.onSignedIn?.(info); } catch { /* card flip is best effort */ }
    } catch (err) {
      log(`check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      w.busy = false;
    }
  };

  const unsubscribe = source.onSignedIn((id) => {
    for (const [key, w] of watches) if (w.id === id) void check(key);
  });

  return {
    list: () => source.list(),
    watch(id, o) {
      const key = keyOf(o.sessionId, id);
      stop(key);
      const timer = setTimeout(() => {
        const w = stop(key);
        if (w) { log(`${id} watch for ${o.sessionId} expired`); try { w.onGaveUp?.("the owner did not sign in in time"); } catch { /* ignore */ } }
      }, o.timeoutMs);
      timer.unref?.();
      const poll = setInterval(() => void check(key), opts.pollMs ?? 5_000);
      poll.unref?.();
      watches.set(key, { id, sessionId: o.sessionId, ...(o.onSignedIn ? { onSignedIn: o.onSignedIn } : {}), ...(o.onGaveUp ? { onGaveUp: o.onGaveUp } : {}), timer, poll, busy: false });
    },
    close() {
      unsubscribe();
      for (const key of [...watches.keys()]) stop(key);
    },
  };
}
