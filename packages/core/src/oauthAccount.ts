// Who is signed in: a cheap, documented "me" read with the OAuth token.
//
// One read does two jobs: it PROVES the token (a 401 means revoked/expired) and
// names the account for the Connections list ("signed in as ..."). Display
// text only: it is cleaned and length-capped, never a secret, never an id that
// could be mistaken for one.

export interface AccountProbe {
  ok: boolean;
  status: number;
  /** Display name or email, when the vendor's answer held one. */
  account?: string;
  /** 401/403: the token is dead (revoked or expired); anything else is "unknown". */
  rejected: boolean;
}

const KEYS = ["email", "mail", "userPrincipalName", "preferred_username", "login", "username", "handle", "screen_name", "display_name", "displayName", "name", "full_name"];

function pick(obj: unknown, depth: number): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) return obj.length ? pick(obj[0], depth) : undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // Slack: {user, team}; Strava: {firstname, lastname}; X/Twitch nest under data.
  if (typeof rec.firstname === "string") return [rec.firstname, rec.lastname].filter((x) => typeof x === "string" && x).join(" ").trim() || undefined;
  if (typeof rec.user === "string" && rec.user) return rec.user;
  if (depth > 0) {
    for (const k of ["data", "user", "profile", "athlete", "account", "me", "owner"]) {
      const found = pick(rec[k], depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Pull a display name/email out of a vendor's userinfo JSON. */
export function accountFromJson(json: unknown): string | undefined {
  const v = pick(json, 2);
  if (!v) return undefined;
  // eslint-disable-next-line no-control-regex
  if (v.length > 120 || /[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v;
}

/** GET (or POST for the few vendors that insist) the identity endpoint with the token. Never throws. */
export async function probeAccount(
  input: { url: string; token: string; method?: "GET" | "POST"; headers?: Record<string, string> },
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AccountProbe> {
  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const res = await doFetch(input.url, {
      method: input.method ?? "GET",
      headers: { authorization: `Bearer ${input.token}`, accept: "application/json", "user-agent": "ares-garrison", ...(input.headers ?? {}) },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 6_000),
      redirect: "manual",
    });
    const rejected = res.status === 401 || res.status === 403;
    if (!res.ok) return { ok: false, status: res.status, rejected };
    const json = (await res.json().catch(() => ({}))) as unknown;
    // Slack answers 200 {ok:false,error:"invalid_auth"} for a dead token.
    if (json && typeof json === "object" && (json as { ok?: unknown }).ok === false) {
      return { ok: false, status: res.status, rejected: /invalid_auth|token_revoked|token_expired|not_authed|account_inactive/.test(String((json as { error?: unknown }).error ?? "")) };
    }
    const account = accountFromJson(json);
    return { ok: true, status: res.status, rejected: false, ...(account ? { account } : {}) };
  } catch {
    return { ok: false, status: 0, rejected: false };
  }
}
