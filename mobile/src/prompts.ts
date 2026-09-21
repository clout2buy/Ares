// What a permission prompt shows, and how a connector need is recognized.
// Mirrors packages/channels/src/telegram/prompts.ts.

const DETAIL_KEYS = ["command", "url", "file_path", "path", "pattern", "to", "recipient", "query", "provider", "text", "action"] as const;
const MAX_DETAIL_CHARS = 220;

function flatten(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(flatten).filter((p): p is string => p !== undefined);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

/** One line of what the tool is actually about to do. */
export function describePermissionInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return flatten(input)?.slice(0, MAX_DETAIL_CHARS);
  const record = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const shown = flatten(record[key]);
    if (shown === undefined) continue;
    const clipped = shown.replace(/\s+/g, " ").trim();
    return clipped.length > MAX_DETAIL_CHARS ? `${clipped.slice(0, MAX_DETAIL_CHARS - 1)}…` : clipped;
  }
  return undefined;
}

const OAUTH_ERROR = /OAUTH_(NOT_AUTHORIZED|EXPIRED):\s*([a-z0-9_.-]+)/i;
const MESSAGE_KEYS = ["message", "error", "detail", "reason", "output", "display", "text"] as const;

export function oauthProviderFromError(source: unknown): { provider: string; expired: boolean } | undefined {
  const candidates: string[] = [];
  if (typeof source === "string") candidates.push(source);
  else if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) if (typeof record[key] === "string") candidates.push(record[key] as string);
  }
  for (const candidate of candidates) {
    const match = OAUTH_ERROR.exec(candidate.slice(0, 2000));
    if (match) return { provider: match[2].toLowerCase(), expired: match[1].toUpperCase() === "EXPIRED" };
  }
  return undefined;
}

export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  spotify: "Spotify",
  github: "GitHub",
  reddit: "Reddit",
  discord: "Discord",
  notion: "Notion",
  slack: "Slack",
  todoist: "Todoist",
  twitch: "Twitch",
  linkedin: "LinkedIn",
  dropbox: "Dropbox",
};
