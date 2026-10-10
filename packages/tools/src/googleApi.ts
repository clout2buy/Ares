// One authenticated fetch for every Google Workspace tool.
//
// Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks and Contacts all
// ride the SAME owner-registered Google app (connect service "google"), so
// they share one token source — getValidAccessToken(OAUTH_PROVIDERS.google),
// which refreshes transparently — and one error shape. The error keeps the
// API's own message (Google's JSON error bodies say exactly which API is
// disabled or which scope is missing) but is capped so a huge HTML error page
// can't flood the model's context.

import { getValidAccessToken, OAUTH_PROVIDERS } from "@ares/core";

export const GOOGLE_API = {
  drive: "https://www.googleapis.com/drive/v3",
  driveUpload: "https://www.googleapis.com/upload/drive/v3",
  docs: "https://docs.googleapis.com/v1",
  sheets: "https://sheets.googleapis.com/v4",
  slides: "https://slides.googleapis.com/v1",
  forms: "https://forms.googleapis.com/v1",
  tasks: "https://tasks.googleapis.com/tasks/v1",
  people: "https://people.googleapis.com/v1",
} as const;

/** Google's error bodies are `{error:{code,message,status}}`; surface the message. */
async function describeFailure(label: string, res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string };
    detail = typeof parsed.error === "object" ? parsed.error?.message ?? text : parsed.error_description ?? String(parsed.error ?? text);
  } catch {
    // not JSON — keep the raw text
  }
  // A Google connection made before Drive/Docs/… joined the scope list holds
  // a token without them: say what fixes it instead of leaving a bare 403.
  const hint = res.status === 403 && /insufficient|scope|has not been used|is disabled/i.test(detail)
    ? ` — the Google connection predates this API or the API is disabled in the owner's Cloud project: enable it there, then Connect "google" again to grant the new access.`
    : "";
  return `${label} ${res.status}: ${detail.replace(/\s+/g, " ").slice(0, 400)}${hint}`;
}

/**
 * Fetch `${base}${path}` as the owner. JSON bodies get a JSON content type
 * unless the caller set one (uploads send multipart). Throws on non-2xx with
 * the API's own message.
 */
export async function googleFetch(label: string, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidAccessToken(OAUTH_PROVIDERS.google);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined && typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  if (!res.ok) throw new Error(await describeFailure(label, res));
  return res;
}

export async function googleJson<T>(label: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await googleFetch(label, url, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Cap text handed back to the model; say how much was cut so it can page. */
export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} more chars]` : text;
}

/** The approval prompt's preview of text Ares is about to put in front of
 *  other people: long enough to judge exactly what goes out. */
export function previewForApproval(text: string | undefined, max = 1200): string {
  const body = (text ?? "").trim();
  if (!body) return "(empty)";
  return body.length > max ? `${body.slice(0, max)}…(+${body.length - max} more chars)` : body;
}
