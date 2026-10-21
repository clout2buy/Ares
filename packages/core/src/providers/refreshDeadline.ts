/** Deadline for one OAuth token exchange (ARES_OAUTH_REFRESH_TIMEOUT_MS, default 15s). */
export function oauthRefreshTimeoutMs(): number {
  const n = Number(process.env.ARES_OAUTH_REFRESH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 200 ? Math.floor(n) : 15_000;
}

/**
 * Run a token exchange under a deadline, both signalled and raced: a refresh
 * is single-flight, so one exchange that never answers would otherwise hold
 * every later turn on that provider forever.
 */
export async function withRefreshDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = oauthRefreshTimeoutMs()): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error("token refresh timed out");
      reason.name = "TimeoutError";
      controller.abort(reason);
      reject(reason);
    }, timeoutMs);
  });
  try {
    return await Promise.race([expired, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}
