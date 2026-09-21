// Settings that survive a relaunch: where the garrison is, the token, and the
// session the owner was last in.

import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Settings {
  url: string;
  token: string;
  lastSessionId?: string;
}

const KEY = "ares.settings.v1";

export async function loadSettings(): Promise<Settings | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return null;
    return { url: parsed.url, token: parsed.token, lastSessionId: parsed.lastSessionId };
  } catch {
    return null;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(settings));
}

export async function clearSettings(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
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

/** A pairing QR carries {"url":…,"token":…} or ares://pair?url=…&token=…. */
export function parsePairPayload(data: string): { url: string; token: string } | null {
  const text = data.trim();
  try {
    const json = JSON.parse(text) as { url?: unknown; token?: unknown };
    if (typeof json.url === "string" && typeof json.token === "string") {
      const url = normalizeGatewayUrl(json.url);
      return url ? { url, token: json.token } : null;
    }
  } catch {
    /* not JSON */
  }
  const match = /^ares:\/\/pair\?(.*)$/i.exec(text);
  if (match) {
    const params = new URLSearchParams(match[1]);
    const url = normalizeGatewayUrl(params.get("url") ?? "");
    const token = params.get("token") ?? "";
    return url && token ? { url, token } : null;
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
