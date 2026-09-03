// Local-server diagnosis — "Ollama is not running" said once, clearly.
//
// undici reports a refused loopback connection as a bare `fetch failed` with
// the ECONNREFUSED buried in `cause`; the ollama adapter forwards only the
// message and marks it retriable, so a stopped Ollama cost the engine's full
// S1 ladder (4 retries, ~25s of exponential backoff) before surfacing a raw
// undici string the owner could not act on. Field data: 19 of last month's
// 42 failed turns were exactly this. On a LOCAL host there is no DNS or TLS
// to blame, so a bare `fetch failed` IS "not running" — classify it, say so
// in one line, and mark it non-retriable so the turn moves on (to the pinned
// failover ladder, or to the owner) immediately.
//
// Import-light on purpose: providers.ts wraps adapters with this at selection
// time, and pinnedFailover.ts recognises the line, so this module must not
// depend on either.

import type { Provider } from "@ares/core";
import type { StreamEvent } from "@ares/protocol";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

/** Is this provider host the owner's own machine (loopback / local name)? */
export function isLocalProviderHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(host) ? host : `http://${host}`);
    return LOCAL_HOSTS.has(url.hostname.toLowerCase()) || /\.local$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export interface LocalProviderFailure {
  message?: string;
  code?: string;
  cause?: unknown;
}

/** The single clear line withLocalProviderDiagnosis emits — recognised by the
 *  failover ladder so it skips the pointless same-provider retry. */
export function isLocalProviderDownMessage(fatal: string | null | undefined): boolean {
  return /is not running at|provider_not_running/i.test(fatal ?? "");
}

/**
 * Classify "the local server isn't up". Returns the owner-facing line, or
 * null when this is some other failure (an HTTP status, a missing model, a
 * remote host — those keep their own messages and retry semantics).
 */
export function classifyLocalProviderDown(
  err: LocalProviderFailure | string | null | undefined,
  host: string | undefined,
  label = "Ollama",
): string | null {
  if (!isLocalProviderHost(host)) return null;
  const e = typeof err === "string" ? { message: err } : err ?? {};
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const blob = `${e.code ?? ""} ${e.message ?? ""} ${cause?.code ?? ""} ${cause?.message ?? ""}`.toLowerCase();
  const refused = /econnrefused|connection refused/.test(blob);
  const bareFetchFailed = /\bfetch failed\b/.test(blob) && !/http_\d{3}|\b[45]\d{2}\b/.test(blob);
  if (!refused && !bareFetchFailed) return null;
  return `${label} is not running at ${host}; start it or pick another provider`;
}

/**
 * Wrap a local-server provider so "server not running" surfaces ONCE as a
 * clear, non-retriable error event. Every other event passes through
 * untouched, and the wrapper keeps the adapter's name so family resolution
 * and telemetry are unchanged. Thrown errors are classified too — the ollama
 * adapter yields ollama_throw for them, but a custom adapter may throw.
 * Remote hosts get the original provider back, unwrapped.
 */
export function withLocalProviderDiagnosis(provider: Provider, host: string | undefined, label = "Ollama"): Provider {
  if (!isLocalProviderHost(host)) return provider;
  const diagnose = (err: LocalProviderFailure | string | null | undefined): StreamEvent | null => {
    const line = classifyLocalProviderDown(err, host, label);
    return line ? { type: "error", error: { code: "provider_not_running", message: line, retriable: false } } : null;
  };
  return {
    get name() {
      return provider.name;
    },
    async *stream(req) {
      let inner: AsyncGenerator<StreamEvent>;
      try {
        inner = provider.stream(req);
      } catch (err) {
        const ev = diagnose(err as LocalProviderFailure);
        if (ev) {
          yield ev;
          return;
        }
        throw err;
      }
      try {
        for await (const ev of inner) {
          if (ev.type === "error") {
            const clear = diagnose(ev.error);
            if (clear) {
              yield clear;
              return;
            }
          }
          yield ev;
        }
      } catch (err) {
        const ev = diagnose(err as LocalProviderFailure);
        if (ev) {
          yield ev;
          return;
        }
        throw err;
      }
    },
  };
}
