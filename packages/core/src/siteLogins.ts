// Website logins in the vault — "I can't see or repeat the values".
//
// Some sites have no API, no OAuth and no session worth saving (they expire
// sessions daily, or the owner just wants Ares to sign in the ordinary way).
// For those the owner types a username and password ONCE into the connect
// hub's secure form (Connect {service:"login:<domain>"}); they land in the
// encrypted vault as login.<domain>.username / login.<domain>.password.
//
// The model never receives either value. The Browser tool's `login` action —
// trusted code, not the model — reads them, fills them into the page after a
// fresh owner approval naming the exact origin, and drops them. The agent
// only ever learns "filled" or "not saved".

import type { ConnectService } from "./connectServices.js";

/** "login:chipotle.com", "login chipotle.com", "login:https://www.chipotle.com/x" → "chipotle.com". */
export function siteLoginDomain(query: string): string | null {
  const match = /^\s*(?:site[-_ ]?)?login\s*[: ]\s*(.+)$/i.exec(query);
  if (!match) return null;
  return normalizeLoginDomain(match[1]!);
}

export function normalizeLoginDomain(raw: string): string | null {
  const trimmed = raw.trim();
  let host = "";
  try {
    host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host.replace(/^www\./, "");
}

/** Vault names for one site's login. Values are never returned to a tool output. */
export function loginCredentialNames(domain: string): { username: string; password: string } {
  return { username: `login.${domain}.username`, password: `login.${domain}.password` };
}

/** The domain and its parents, most specific first — accounts.example.com's
 *  login may be saved under example.com. Stops at the registrable pair. */
export function loginDomainCandidates(host: string): string[] {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 2 <= parts.length; i += 1) out.push(parts.slice(i).join("."));
  return out;
}

/** The api-key-style secure form the connect hub renders for a site login. */
export function siteLoginService(domain: string): ConnectService {
  const names = loginCredentialNames(domain);
  return {
    id: `login:${domain}`,
    label: `${domain} login`,
    kind: "api-key",
    blurb: `Save your ${domain} sign-in so Ares can log in for you. Ares fills it straight into ${domain}'s own page after you approve each sign-in — it can't see or repeat the values.`,
    keywords: [`login:${domain}`],
    domain,
    howToUse: `Open ${domain}'s sign-in page with the Browser tool, then call Browser {action:"login"}. The owner approves the fill; you never see the values, so never ask for them.`,
    fields: [
      { credential: names.username, label: "Username or email", placeholder: "you@example.com" },
      { credential: names.password, label: "Password", secret: true },
    ],
  };
}
