// Dev-only: make a plain browser tab behave like the desktop shell by routing
// Tauri commands to scripts/dev-web-bridge.mjs (a real daemon on loopback).
// Active only in `vite dev` AND with ?bridge=<url>; inert in every build.

type Internals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (cb: unknown) => number;
  convertFileSrc: (path: string) => string;
  metadata: unknown;
};

(function installDevBridge() {
  try {
    if (!import.meta.env.DEV) return;
    const g = globalThis as unknown as { isTauri?: boolean; __ARES_DEV_BRIDGE__?: string; __TAURI_INTERNALS__?: Internals; __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown };
    if (g.isTauri) return;
    const base = new URLSearchParams(location.search).get("bridge");
    if (!base) return;
    const url = base.replace(/\/+$/, "");
    g.isTauri = true;
    // Native-only views (the Forge's child webview) check this to fall back to HTML.
    g.__ARES_DEV_BRIDGE__ = url;
    g.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    g.__TAURI_INTERNALS__ = {
      transformCallback: () => 0,
      convertFileSrc: (p: string) => `${url}/file?path=${encodeURIComponent(p)}`,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd.startsWith("plugin:event|listen")) return 1;
        if (cmd.startsWith("plugin:")) return null;
        const res = await fetch(`${url}/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, args: args ?? {} }) });
        const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
        if (!body.ok) throw new Error(body.error ?? `${cmd} failed`);
        return body.value;
      },
    };
    console.info(`[ares dev bridge] attached to ${url}`);
  } catch (err) {
    console.warn("[ares dev bridge] not installed:", err);
  }
})();
