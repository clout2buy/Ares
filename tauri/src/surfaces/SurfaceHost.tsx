// The one iframe host every placement uses (card, rail, pane, window). It
// frames a ledger document at an opaque origin behind a no-network CSP,
// injects the shell's design tokens so the document looks native without
// seeing the shell, and runs the bridge: posts down (feeds, replies, call
// results), intents / faults / calls up. The host never trusts the document;
// the document never sees the host.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { surfaceWebUrl, type SurfaceDocument } from "../../../packages/protocol/src/surfaces";
import { MAX_CSS, MAX_HTML, MAX_JS, SURFACE_CSP, sanitizeCss, sanitizeHtml, sanitizeScript } from "./sanitize";
import { noteSurfaceContent, setSurfaceVisibility, subscribeSurfacePosts } from "./postBus";

export interface SurfaceThemeTokens {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  ember: string;
  radius: string;
  font: string;
  mono: string;
  /** How the app paints its own panels, so a surface can match them exactly. */
  fill: string;
  rim: string;
  shadow: string;
  blur: string;
  scheme: "dark" | "light";
}

/** The shell's tokens, read off the `.ares` root so a surface inherits the
 * owner's surface + accent choice (glass, cyber, messages…) without any
 * access to the page. */
export function readThemeTokens(): SurfaceThemeTokens {
  const root = document.querySelector(".ares") ?? document.documentElement;
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const theme = root.getAttribute("data-theme") ?? "";
  const bg = read("--bg", "#0b0d12");
  return {
    bg,
    panel: read("--panel", "#141821"),
    text: read("--text", "#e8e6e1"),
    muted: read("--muted", "#9aa0a8"),
    line: read("--line", "rgba(255,255,255,.12)"),
    accent: read("--accent", "#5a8cff"),
    ember: read("--ember", "#ff6a30"),
    radius: read("--r-md", "14px"),
    font: read("--font", "\"Segoe UI\", system-ui, sans-serif"),
    mono: read("--mono", "\"Cascadia Mono\", Consolas, monospace"),
    fill: read("--g-fill", read("--panel", "#141821")),
    rim: read("--g-rim", `1px solid ${read("--line", "rgba(255,255,255,.12)")}`),
    shadow: read("--g-shadow", "0 12px 32px rgba(0,0,0,.28)"),
    blur: read("--g-blur", "blur(18px)"),
    scheme: /light/i.test(theme) || isLight(bg) ? "light" : "dark",
  };
}

function isLight(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return false;
  const n = parseInt(hex[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
}

function tokenCss(t: SurfaceThemeTokens, transparent = false): string {
  return `:root{color-scheme:${transparent ? "normal" : t.scheme};--ares-bg:${t.bg};--ares-panel:${t.panel};--ares-text:${t.text};--ares-muted:${t.muted};--ares-line:${t.line};--ares-accent:${t.accent};--ares-ember:${t.ember};--ares-radius:${t.radius};--ares-font:${t.font};--ares-mono:${t.mono};--ares-fill:${t.fill};--ares-rim:${t.rim};--ares-shadow:${t.shadow};--ares-blur:${t.blur};}
html,body{margin:0;min-height:100%;background:${transparent ? "transparent" : "var(--ares-bg)"};color:var(--ares-text);font-family:var(--ares-font);}
*{box-sizing:border-box;}button,input,select,textarea{font:inherit;}`;
}

/** Uses one element as a person would. Serialised into the bridge, so it runs
 * the same on the app and inside a sealed document. */
export function pokeElement(root: Document, act: { selector: string; text?: string; key?: string }): string {
  const nameOf = (n: Element) => (n.getAttribute("aria-label") || n.getAttribute("title") || n.textContent || "").trim().replace(/\s+/g, " ");
  const controls = () => Array.from(root.querySelectorAll("button, a, input, textarea, select, [role=button], [role=tab], [role=menuitem]")).filter((n) => {
    const box = n.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  let el: HTMLElement | null = null;
  try {
    el = root.querySelector(act.selector);
  } catch {
    /* not a selector, so it may be the name of a control */
  }
  if (!el) {
    // Asked by name or by a label that does not exist as a selector: find the
    // control a person would take that to mean.
    const wanted = act.selector.replace(/^.*["']([^"']+)["'].*$/, "$1").trim().toLowerCase();
    const all = controls();
    el = (wanted.length > 1 ? (all.find((n) => nameOf(n).toLowerCase() === wanted) ?? all.find((n) => nameOf(n).toLowerCase().includes(wanted))) : null) as HTMLElement | null ?? null;
  }
  if (!el) {
    const names = Array.from(new Set(controls().map(nameOf).filter(Boolean))).slice(0, 14);
    return `nothing matches ${act.selector}${names.length ? `. Controls on screen: ${names.join(", ")}` : ""}`;
  }
  const target = el;
  const name = target.tagName.toLowerCase();
  const called = nameOf(target).slice(0, 40);
  const said = called ? `${name} "${called}"` : name;
  const press = () => {
    target.focus();
    const init = { bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.click();
    return `clicked ${said}`;
  };
  if (act.key && !/^click$/i.test(act.key)) {
    target.focus();
    for (const type of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(type, { key: act.key, bubbles: true, cancelable: true }));
    return `pressed ${act.key} on ${said}`;
  }
  if (act.text === undefined) return press();
  const field = "value" in target || target.isContentEditable;
  if (!field) return `${said} is not a text field, so nothing was typed: leave text out to click it`;
  if ((target as HTMLInputElement).disabled || (target as HTMLInputElement).readOnly) return `${name} is disabled, so nothing could be typed`;
  target.focus();
  if ("value" in target) {
    const proto = name === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, act.text);
  } else {
    target.textContent = act.text;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return `typed into ${said}`;
}

/* Injected ahead of the surface's own script. Everything the document may do
 * beyond rendering flows through here. */
const BRIDGE_SCRIPT = `
(() => {
  const queue = [];
  const listeners = [];
  const themeListeners = [];
  const shareListeners = [];
  const calls = new Map();
  let callSeq = 0;
  let theme = __THEME__;
  const applyTheme = (t) => {
    theme = t;
    const r = document.documentElement.style;
    r.setProperty("--ares-bg", t.bg); r.setProperty("--ares-panel", t.panel); r.setProperty("--ares-text", t.text);
    r.setProperty("--ares-muted", t.muted); r.setProperty("--ares-line", t.line); r.setProperty("--ares-accent", t.accent);
    r.setProperty("--ares-ember", t.ember); r.setProperty("--ares-radius", t.radius); r.setProperty("--ares-font", t.font); r.setProperty("--ares-mono", t.mono);
    r.setProperty("--ares-fill", t.fill); r.setProperty("--ares-rim", t.rim); r.setProperty("--ares-shadow", t.shadow); r.setProperty("--ares-blur", t.blur);
    r.setProperty("color-scheme", t.scheme);
    for (const fn of themeListeners) { try { fn(t); } catch {} }
  };
  const keep = (op, key, value) => {
    const id = "s" + (++callSeq) + "_" + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      parent.postMessage({ __ares: 1, type: "store", callId: id, op, key: key === undefined ? "" : String(key), value }, "*");
    });
  };
  const ares = {
    send(text) {
      if (typeof text !== "string" || !text.trim()) return;
      parent.postMessage({ __ares: 1, type: "send", text: text.trim().slice(0, 6000) }, "*");
    },
    onPost(fn) {
      if (typeof fn !== "function") return;
      listeners.push(fn);
      for (const payload of queue.splice(0)) { try { fn(payload); } catch {} }
    },
    call(tool, input) {
      const id = "c" + (++callSeq) + "_" + Date.now().toString(36);
      return new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject });
        parent.postMessage({ __ares: 1, type: "call", callId: id, tool: String(tool || ""), input: input === undefined ? {} : input }, "*");
        setTimeout(() => { if (calls.has(id)) { calls.delete(id); reject(new Error("call timed out")); } }, 10 * 60 * 1000);
      });
    },
    share(topic, data) { parent.postMessage({ __ares: 1, type: "share", topic: String(topic || ""), data: data === undefined ? null : data }, "*"); },
    onShare(fn) { if (typeof fn === "function") shareListeners.push(fn); },
    frame(next) { parent.postMessage({ __ares: 1, type: "frame", frame: next || {} }, "*"); },
    close() { parent.postMessage({ __ares: 1, type: "close" }, "*"); },
    show(name) { parent.postMessage({ __ares: 1, type: "visibility", op: "show", target: name }, "*"); },
    hide(name) { parent.postMessage({ __ares: 1, type: "visibility", op: "hide", target: name }, "*"); },
    toggle(name) { parent.postMessage({ __ares: 1, type: "visibility", op: "toggle", target: name }, "*"); },
    store: Object.freeze({
      get(key) { return keep("get", key); },
      set(key, value) { return keep("set", key, value); },
      remove(key) { return keep("remove", key); },
      all() { return keep("all"); },
    }),
    get theme() { return theme; },
    onTheme(fn) { if (typeof fn === "function") themeListeners.push(fn); },
  };
  window.ares = Object.freeze(ares);
  addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.__ares !== 1) return;
    if (data.type === "theme" && data.tokens) { applyTheme(data.tokens); return; }
    if (data.type === "poke") { parent.postMessage({ __ares: 1, type: "poked", result: __POKE__(document, data.act) }, "*"); return; }
    if (data.type === "morph" && Array.isArray(data.ops)) {
      // Region patches land in the live DOM; script state, scroll and focus
      // survive. The host already decided nothing here needs a reload.
      const region = (target) => Array.from(document.querySelectorAll("[data-ares-region]")).find((el) => el.getAttribute("data-ares-region") === target) || null;
      for (const op of data.ops) {
        if (op.op === "set_css") { let st = document.getElementById("ares-surface-css"); if (!st) { st = document.createElement("style"); st.id = "ares-surface-css"; document.head.appendChild(st); } st.textContent = op.css; continue; }
        if (op.op === "set_title") { document.title = op.title; continue; }
        const el = region(op.target);
        if (!el) continue;
        if (op.op === "remove_region") el.remove();
        else if (op.op === "replace_region") el.innerHTML = op.html;
        else if (op.op === "append_region") el.insertAdjacentHTML("beforeend", op.html);
        else if (op.op === "prepend_region") el.insertAdjacentHTML("afterbegin", op.html);
      }
      return;
    }
    if (data.type !== "post") return;
    const payload = data.payload;
    if (payload && typeof payload === "object" && payload.__call === 1 && typeof payload.callId === "string") {
      const pending = calls.get(payload.callId);
      if (pending) { calls.delete(payload.callId); payload.ok ? pending.resolve(payload.output) : pending.reject(new Error(String(payload.error || "call failed"))); }
      return;
    }
    if (payload && typeof payload === "object" && payload.__share === 1) {
      for (const fn of shareListeners) { try { fn(payload.topic, payload.data, payload.from); } catch {} }
      return;
    }
    if (!listeners.length) { queue.push(payload); return; }
    for (const fn of listeners) { try { fn(payload); } catch {} }
  });
  document.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target.closest("[data-ares-action]") : null;
    if (!el) return;
    event.preventDefault();
    const action = el.getAttribute("data-ares-action");
    if (action) ares.send(action);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const fields = {};
    new FormData(form).forEach((value, key) => { fields[key] = String(value); });
    const action = form.getAttribute("data-ares-action") || "Respond to this surface form";
    ares.send(action + "\\nStructured form values: " + JSON.stringify(fields));
  }, true);
  // Report the content's real height so a slot can hug it. Measured from the
  // elements themselves: body is stretched to the frame by the base styles.
  const report = () => {
    let bottom = 0;
    for (const el of document.body.children) {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      const box = el.getBoundingClientRect();
      if (getComputedStyle(el).position !== "fixed") bottom = Math.max(bottom, box.bottom + scrollY);
    }
    // What the document really draws, scrollers counted as their own box, so
    // the host can say when a frame cuts part of it off.
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (parentEl) => {
      for (const el of parentEl.children) {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && style.position !== "fixed") {
          box[0] = Math.min(box[0], r.left); box[1] = Math.min(box[1], r.top); box[2] = Math.max(box[2], r.right); box[3] = Math.max(box[3], r.bottom);
        }
        if (style.overflowX === "visible" && style.overflowY === "visible") walk(el);
      }
    };
    walk(document.body);
    parent.postMessage({ __ares: 1, type: "size", height: Math.ceil(bottom), box: box[0] === Infinity ? null : box, frame: [innerWidth, innerHeight] }, "*");
  };
  addEventListener("load", report);
  addEventListener("resize", report);
  let reporting = 0;
  new MutationObserver(() => { if (!reporting) reporting = requestAnimationFrame(() => { reporting = 0; report(); }); }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  if (typeof ResizeObserver === "function") {
    const watch = new ResizeObserver(report);
    addEventListener("DOMContentLoaded", () => { for (const el of document.body.children) watch.observe(el); report(); });
  }
  addEventListener("pointerdown", (event) => {
    const grip = event.target.closest && event.target.closest("[data-ares-drag]");
    if (!grip || event.target.closest("button, input, textarea, select, a")) return;
    let x = event.screenX, y = event.screenY;
    grip.setPointerCapture(event.pointerId);
    const move = (e) => { parent.postMessage({ __ares: 1, type: "drag", dx: e.screenX - x, dy: e.screenY - y }, "*"); x = e.screenX; y = e.screenY; };
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); parent.postMessage({ __ares: 1, type: "drag", done: true }, "*"); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    event.preventDefault();
  });
  addEventListener("error", (event) => {
    parent.postMessage({ __ares: 1, type: "fault", message: String(event.message || event.error || "script error").slice(0, 400) }, "*");
  });
  addEventListener("unhandledrejection", (event) => {
    parent.postMessage({ __ares: 1, type: "fault", message: ("unhandled rejection: " + String(event.reason)).slice(0, 400) }, "*");
  });
})();
`;

export function buildSurfaceDocument(doc: SurfaceDocument, tokens: SurfaceThemeTokens, transparent = false): string {
  const bridge = BRIDGE_SCRIPT.replace("__THEME__", JSON.stringify(tokens)).replace("__POKE__", () => `(${pokeElement.toString()})`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${SURFACE_CSP}"><title>${escapeHtml(doc.title)}</title><style>${tokenCss(tokens, transparent)}</style><style id="ares-surface-css">${sanitizeCss(doc.css.slice(0, MAX_CSS))}</style></head><body>${sanitizeHtml(doc.html.slice(0, MAX_HTML))}<script>${sanitizeScript(bridge)}</script><script>${sanitizeScript(doc.js.slice(0, MAX_JS))}</script></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" })[c] ?? c);
}

/** Packaged builds must serve the document over the sealed scheme (a srcdoc
 * frame inherits the app CSP and loses every generated style/script); the
 * dev bridge and the browser preview have no such CSP and no scheme. */
function useStagedSrc(html: string, native: boolean): { src?: string; srcDoc?: string; error: string | null } {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!native) return;
    let stale = false;
    invoke<string>("ares_living_surface_stage", { document: html })
      .then((url) => { if (!stale) { setSrc(url); setError(null); } })
      .catch((err) => { if (!stale) setError(String(err)); });
    return () => { stale = true; };
  }, [html, native]);
  if (!native) return { srcDoc: html, error: null };
  return src ? { src, error } : { error };
}

export interface SurfaceMorph {
  revision: number;
  ops: Array<Record<string, unknown>>;
}

export interface SurfaceHostProps {
  name: string;
  document: SurfaceDocument;
  /** Bumps when the document is a new revision; the frame reloads then —
   *  unless `morph` carries that revision's region ops, which are applied to
   *  the running document instead. */
  revision: number;
  morph?: SurfaceMorph | null;
  /** Hug the document's content, up to this many pixels. */
  fitMax?: number;
  /** See-through document (free surfaces). */
  transparent?: boolean;
  /** The document asked to move or close itself. */
  onFrame?: (frame: Record<string, unknown>) => void;
  /** The owner is dragging the surface by a data-ares-drag element. */
  onDrag?: (dx: number, dy: number, done: boolean) => void;
  onClose?: () => void;
  onIntent: (text: string) => void;
  onFault: (message: string) => void;
  onCall?: (callId: string, tool: string, input: unknown) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function SurfaceHost({ name, document: doc, revision, morph, fitMax, transparent, onFrame, onDrag, onClose, onIntent, onFault, onCall, className, style }: SurfaceHostProps) {
  const [fitHeight, setFitHeight] = useState<number | null>(null);
  const native = isTauri() && !(globalThis as { __ARES_DEV_BRIDGE__?: string }).__ARES_DEV_BRIDGE__;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loaded = useRef(false);
  const pendingPosts = useRef<unknown[]>([]);
  const [tokens, setTokens] = useState(() => readThemeTokens());
  // What the frame actually loaded. A morphable revision is applied to the
  // running document through the bridge and does NOT touch `frameDoc`, so the
  // srcdoc stays put and the frame keeps its script state; the next real
  // reload (a theme flip, a remount) builds from the newest document.
  const [frameDoc, setFrameDoc] = useState<SurfaceDocument>(doc);
  const appliedRevision = useRef(revision);
  useEffect(() => {
    if (revision === appliedRevision.current) return;
    const canMorph = morph && morph.revision === revision && revision === appliedRevision.current + 1 && loaded.current && iframeRef.current?.contentWindow;
    appliedRevision.current = revision;
    if (canMorph) {
      iframeRef.current!.contentWindow!.postMessage({ __ares: 1, type: "morph", ops: morph.ops }, "*");
      return;
    }
    setFrameDoc(doc);
  }, [doc, revision, morph]); // eslint-disable-line react-hooks/exhaustive-deps
  // The document is built once per loaded revision + initial theme; theme
  // changes after that are posted into the running document, not rebuilt.
  const html = useMemo(() => buildSurfaceDocument(frameDoc, tokens, transparent), [frameDoc, tokens.scheme, transparent]); // eslint-disable-line react-hooks/exhaustive-deps
  const staged = useStagedSrc(html, native);

  const post = useCallback((payload: unknown) => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || !loaded.current) {
      pendingPosts.current.push(payload);
      pendingPosts.current = pendingPosts.current.slice(-50);
      return;
    }
    frame.postMessage({ __ares: 1, type: "post", payload }, "*");
  }, []);

  useEffect(() => subscribeSurfacePosts(name, post), [name, post]);

  // Follow the shell's theme: re-read tokens when the root's data-* change.
  useEffect(() => {
    const root = document.querySelector(".ares");
    if (!root) return;
    const observer = new MutationObserver(() => {
      const next = readThemeTokens();
      setTokens(next);
      iframeRef.current?.contentWindow?.postMessage({ __ares: 1, type: "theme", tokens: next }, "*");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-accent", "data-style", "data-surface", "data-glass"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { __ares?: number; type?: string; text?: string; message?: string; callId?: string; tool?: string; input?: unknown; height?: number } | null;
      if (!data || data.__ares !== 1) return;
      if (data.type === "frame") { onFrame?.(((data as { frame?: Record<string, unknown> }).frame) ?? {}); return; }
      if (data.type === "close") { onClose?.(); return; }
      if (data.type === "share") {
        void invoke("ares_daemon_command", { command: { type: "surface_share", surface: name, topic: (data as { topic?: string }).topic ?? "", input: (data as { data?: unknown }).data } }).catch(() => null);
        return;
      }
      if (data.type === "visibility") {
        const v = data as { op?: "show" | "hide" | "toggle"; target?: unknown };
        if (v.op) setSurfaceVisibility(typeof v.target === "string" && v.target ? v.target : name, v.op);
        return;
      }
      if (data.type === "store") {
        const s = data as { callId?: string; op?: string; key?: string; value?: unknown };
        void invoke("ares_daemon_command", { command: { type: "surface_store", surface: name, callId: s.callId, op: s.op, key: s.key, input: s.value } }).catch(() => null);
        return;
      }
      if (data.type === "size") {
        const c = data as { box?: [number, number, number, number] | null; frame?: [number, number] };
        if (c.box && c.frame) noteSurfaceContent(name, c.box, c.frame);
      }
      if (data.type === "size" && fitMax && typeof data.height === "number" && data.height > 0) setFitHeight(Math.min(data.height, fitMax));
      if (data.type === "drag") { const d = data as { dx?: number; dy?: number; done?: boolean }; onDrag?.(Number(d.dx) || 0, Number(d.dy) || 0, d.done === true); }
      if (data.type === "send" && typeof data.text === "string") onIntent(data.text);
      else if (data.type === "fault" && typeof data.message === "string") onFault(data.message);
      else if (data.type === "call" && typeof data.callId === "string" && typeof data.tool === "string") {
        if (onCall) onCall(data.callId, data.tool, data.input);
        else post({ __call: 1, callId: data.callId, ok: false, error: "this placement cannot call tools" });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onIntent, onFault, onCall, post, fitMax, onFrame, onDrag, onClose]);

  const onLoad = useCallback(() => {
    loaded.current = true;
    const frame = iframeRef.current?.contentWindow;
    if (!frame) return;
    for (const payload of pendingPosts.current.splice(0)) frame.postMessage({ __ares: 1, type: "post", payload }, "*");
  }, []);

  // A new revision means a new document: posts wait for the fresh frame.
  useEffect(() => { loaded.current = false; }, [html]);

  if (staged.error) {
    return <div className={`surfaceHostError ${className ?? ""}`} style={style}>Could not stage the surface: {staged.error}</div>;
  }
  const web = surfaceWebUrl(doc.html);
  if (web) {
    return (
      <iframe
        className={`surfaceFrame surfaceWeb ${className ?? ""}`}
        data-surface={name}
        style={style}
        title={doc.title || name}
        src={web}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    );
  }
  if (native && !staged.src) return <div className={`surfaceHostLoading ${className ?? ""}`} style={style} />;
  return (
    <iframe
      ref={iframeRef}
      className={`surfaceFrame ${className ?? ""}`}
      data-surface={name}
      style={transparent ? { ...style, background: "transparent", colorScheme: "normal" } : fitMax ? { ...style, height: fitHeight ?? style?.height } : style}
      title={doc.title || name}
      sandbox="allow-scripts allow-forms allow-pointer-lock"
      {...(native ? { src: staged.src } : { srcDoc: staged.srcDoc })}
      onLoad={onLoad}
    />
  );
}
