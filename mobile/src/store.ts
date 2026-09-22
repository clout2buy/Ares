// Settings that survive a relaunch. The app is a hub for many Ares instances
// — each a Profile (name, where it is, the token that opens it, the session
// you were last in). One is active at a time. Older installs stored a single
// {url, token}; they migrate into a one-profile list on first load.

import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Profile {
  id: string;
  name: string;
  url: string;
  token: string;
  /** Accent for the avatar so instances read apart at a glance. */
  color: string;
  lastSessionId?: string;
  lastSeenAt?: number;
}

export interface Settings {
  profiles: Profile[];
  activeId?: string;
}

const KEY = "ares.settings.v2";
const LEGACY_KEY = "ares.settings.v1";

export const PROFILE_COLORS = ["#ff7a1a", "#3fa9f5", "#3fd18b", "#c084fc", "#f5c542", "#ff5c8a"];

export function newProfileId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A sensible default name from the gateway host: ares.mistiqueai.com → "mistiqueai". */
export function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const parts = host.split(".").filter((p) => p !== "ares" && p !== "www");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch {
    return "Ares";
  }
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Settings;
      if (Array.isArray(parsed.profiles)) return parsed;
    }
    // Migrate a v1 single-garrison install into one profile.
    const legacy = await AsyncStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as { url?: string; token?: string; lastSessionId?: string };
      if (typeof old.url === "string" && typeof old.token === "string") {
        const profile: Profile = { id: newProfileId(), name: nameFromUrl(old.url), url: old.url, token: old.token, color: PROFILE_COLORS[0], lastSessionId: old.lastSessionId };
        const migrated: Settings = { profiles: [profile], activeId: profile.id };
        await saveSettings(migrated);
        return migrated;
      }
    }
  } catch {
    /* fall through to empty */
  }
  return { profiles: [] };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(settings));
}

export async function clearSettings(): Promise<void> {
  await AsyncStorage.multiRemove([KEY, LEGACY_KEY]);
}

export function activeProfile(settings: Settings): Profile | undefined {
  return settings.profiles.find((p) => p.id === settings.activeId) ?? settings.profiles[0];
}

/** Accepts a gateway origin in any of the shapes a person types or scans. */
export function normalizeGatewayUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `wss://${raw}`;
  raw = raw.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  try {
    const url = new URL(raw);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/gateway";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** A pairing QR carries {"url":…,"token":…,"name"?:…} or ares://pair?url=…&token=…. */
export function parsePairPayload(data: string): { url: string; token: string; name?: string } | null {
  const text = data.trim();
  try {
    const json = JSON.parse(text) as { url?: unknown; token?: unknown; name?: unknown };
    if (typeof json.url === "string" && typeof json.token === "string") {
      const url = normalizeGatewayUrl(json.url);
      return url ? { url, token: json.token, name: typeof json.name === "string" ? json.name : undefined } : null;
    }
  } catch {
    /* not JSON */
  }
  const match = /^ares:\/\/pair\?(.*)$/i.exec(text);
  if (match) {
    const params = new URLSearchParams(match[1]);
    const url = normalizeGatewayUrl(params.get("url") ?? "");
    const token = params.get("token") ?? "";
    return url && token ? { url, token, name: params.get("name") ?? undefined } : null;
  }
  return null;
}

/** wss://host/gateway → https://host — where the phone API lives. */
export function httpOriginOf(gatewayUrl: string): string {
  try {
    const url = new URL(gatewayUrl);
    const scheme = url.protocol === "ws:" ? "http:" : "https:";
    return `${scheme}//${url.host}`;
  } catch {
    return "";
  }
}
