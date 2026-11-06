// "Anywhere": a surface placed at `at:<position>:<selector>` lands against any
// element in the app, whether or not anyone planned a slot there — the
// titlebar, a Settings page, a chat row. The element is found by selector and
// watched, so a target that appears later (Settings opening) gets its surface
// then, and one that leaves takes the surface with it.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { SlotSurface } from "./SlotHost";
import { SurfaceHost } from "./SurfaceHost";
import { useSurfaces, type SurfaceVm } from "./SurfacesContext";
import { declareSurfaceHidden, setSurfaceVisibility, subscribeSurfaceVisibility, surfaceIsHidden } from "./postBus";
import { surfaceWebUrl } from "../../../packages/protocol/src/surfaces";

type Position = "before" | "after" | "inside" | "start" | "replace";

function parse(placement: string): { position: Position; selector: string } | null {
  const m = /^at:(before|after|inside|start|replace):([\s\S]+)$/.exec(placement);
  return m ? { position: m[1] as Position, selector: m[2] } : null;
}

function find(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/** Beside a pinned element there is no flow to join: the neighbour may sit in
 * a bar 12px tall with everything in it fixed. So the surface pins itself next
 * to the target's real box, and slides past any control already there. */
function pinBeside(container: HTMLElement, el: Element, side: "before" | "after"): void {
  const box = el.getBoundingClientRect();
  const own = container.getBoundingClientRect();
  const width = own.width || 28;
  const height = own.height || 28;
  const gap = 4;
  let left = side === "before" ? box.left - gap - width : box.right + gap;
  const y = box.top + box.height / 2;
  const inView = (x: number) => x >= 4 && x + width <= innerWidth - 4;
  // Looks through the surface itself: it is on top of whatever it landed on
  // every time this runs after the first.
  const controlAt = (x: number) => document.elementsFromPoint(x, y)
    .filter((hit) => !container.contains(hit))
    .map((hit) => hit.closest("button, a, input, [role=tab], .anchorHost"))
    .find((hit) => hit && hit !== el);
  const slide = (start: number, way: "before" | "after"): number | null => {
    let x = start;
    for (let i = 0; i < 12; i += 1) {
      if (!inView(x)) return null;
      const other = controlAt(x + 2) ?? controlAt(x + width / 2) ?? controlAt(x + width - 2);
      if (!other) return x;
      const r = other.getBoundingClientRect();
      x = way === "before" ? r.left - gap - width : r.right + gap;
    }
    return null;
  };
  // Asked for one side and it is full (the corner has the window controls in
  // it): the near side of the target is the next best thing, never off screen.
  const near = side === "before" ? left : box.left - gap - width;
  left = slide(left, side) ?? slide(side === "before" ? box.right + gap : near, side === "before" ? "after" : "before") ?? Math.min(Math.max(left, 4), innerWidth - width - 4);
  container.style.margin = "0";
  container.style.position = "fixed";
  container.style.zIndex = container.style.zIndex || "96";
  container.style.left = `${Math.round(left)}px`;
  container.style.top = `${Math.round(box.top + (box.height - height) / 2)}px`;
}

function Anchored({ vm }: { vm: SurfaceVm }) {
  const spec = useMemo(() => parse(vm.manifest.placement), [vm.manifest.placement]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!spec) return;
    let container: HTMLElement | null = null;
    let target: Element | null = null;
    let hidden: { el: HTMLElement; display: string } | null = null;
    let frame = 0;
    const detach = () => {
      if (hidden) hidden.el.style.display = hidden.display;
      hidden = null;
      container?.remove();
      container = null;
      target = null;
      setHost(null);
    };
    const place = () => {
      if (!container || !target || (spec.position !== "before" && spec.position !== "after")) return;
      const position = getComputedStyle(target).position;
      if (position === "fixed" || position === "absolute") pinBeside(container, target, spec.position);
    };
    const attach = () => {
      frame = 0;
      if (target?.isConnected && container?.isConnected) { place(); return; }
      if (container) detach();
      const el = find(spec.selector);
      if (!el || el.closest("[data-anchor-host]")) return;
      target = el;
      container = document.createElement("div");
      container.dataset.anchorHost = vm.manifest.name;
      container.className = "anchorHost";
      Object.assign(container.style, vm.manifest.frame?.style ?? {});
      if (spec.position === "before") el.before(container);
      else if (spec.position === "after") el.after(container);
      else if (spec.position === "inside") el.append(container);
      else if (spec.position === "start") el.prepend(container);
      else {
        el.after(container);
        const box = el as HTMLElement;
        hidden = { el: box, display: box.style.display };
        box.style.display = "none";
      }
      place();
      setHost(container);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(attach); };
    window.addEventListener("resize", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    attach();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      detach();
    };
  }, [spec, vm.manifest.name, JSON.stringify(vm.manifest.frame?.style ?? null)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!host) return null;
  // A frame means the document is the whole control: no card around it.
  return createPortal(vm.manifest.frame ? <Framed vm={vm} host={host} /> : <SlotSurface vm={vm} slot="anchor" />, host);
}

export function AnchoredSurfaces() {
  const { surfaces } = useSurfaces();
  const anchored = useMemo(() => Object.values(surfaces).filter((s) => s.manifest.placement.startsWith("at:")), [surfaces]);
  return <>{anchored.map((vm) => <Anchored key={vm.manifest.name} vm={vm} />)}</>;
}

interface LiveFrame { movable?: boolean; style?: Record<string, string>; transparent?: boolean; clickThrough?: boolean }

/** Follows ares.show / hide / toggle for this surface. */
function useHidden(vm: SurfaceVm): boolean {
  const name = vm.manifest.name;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  declareSurfaceHidden(name, vm.manifest.frame?.hidden === true);
  useEffect(() => subscribeSurfaceVisibility((target) => { if (target === name) redraw(); }), [name]);
  return surfaceIsHidden(name);
}

function Framed({ vm, host }: { vm: SurfaceVm; host: HTMLElement }) {
  const api = useSurfaces();
  const name = vm.manifest.name;
  const onIntent = useCallback((t: string) => api.intent(name, t), [api, name]);
  const onFault = useCallback((m: string) => api.fault(name, m), [api, name]);
  const onCall = useCallback((id: string, tool: string, input: unknown) => api.call(name, id, tool, input), [api, name]);
  const onFrame = useCallback((f: Record<string, unknown>) => {
    Object.assign(host.style, (f as LiveFrame).style ?? {});
    window.dispatchEvent(new Event("resize"));
  }, [host]);
  const hidden = useHidden(vm);
  useEffect(() => { host.style.display = hidden ? "none" : ""; }, [host, hidden]);
  const onClose = useCallback(() => api.remove(name), [api, name]);
  return <SurfaceHost name={name} document={vm.document} revision={vm.manifest.revision} morph={vm.morph} transparent={vm.manifest.frame?.transparent ?? true} onFrame={onFrame} onClose={onClose} onIntent={onIntent} onFault={onFault} onCall={onCall} className="freeFrame" />;
}

interface Place { left: number; top: number; width: number; height: number; of: string }

/** Where the owner left a panel. `of` is the shape Ares gave it: when Ares places
 * it somewhere new, that wins over the old drag. */
function readPlace(name: string, of: string): Place | null {
  try {
    const saved = JSON.parse(localStorage.getItem(`ares.surface.place.${name}`) ?? "null") as Place | null;
    return saved && saved.of === of ? saved : null;
  } catch {
    return null;
  }
}

/** A free surface: its shape, layer and see-through-ness are the document's
 * to choose, at creation and live. */
function Free({ vm }: { vm: SurfaceVm }) {
  const api = useSurfaces();
  const name = vm.manifest.name;
  const [live, setLive] = useState<LiveFrame>({});
  const base = (vm.manifest as { frame?: LiveFrame }).frame ?? {};
  const onIntent = useCallback((t: string) => api.intent(name, t), [api, name]);
  const onFault = useCallback((m: string) => api.fault(name, m), [api, name]);
  const onCall = useCallback((id: string, tool: string, input: unknown) => api.call(name, id, tool, input), [api, name]);
  const onFrame = useCallback((f: Record<string, unknown>) => setLive((cur) => ({ ...cur, ...(f as LiveFrame), style: { ...cur.style, ...(f as LiveFrame).style } })), []);
  const onClose = useCallback(() => api.remove(name), [api, name]);
  // A floating surface draws its own shape; an opaque frame would show as
  // square corners behind anything rounded.
  const transparent = live.transparent ?? base.transparent ?? true;
  const clickThrough = live.clickThrough ?? base.clickThrough ?? false;
  const hidden = useHidden(vm);
  const web = surfaceWebUrl(vm.document.html);
  const movable = live.movable ?? base.movable ?? Boolean(web);
  const shape = JSON.stringify(base.style ?? {});
  const box = useRef<HTMLDivElement | null>(null);
  const reloadKey = useRef(0);
  const [, reload] = useReducer((n: number) => n + 1, 0);
  const [place, setPlace] = useState<Place | null>(() => (movable ? readPlace(name, shape) : null));
  const [moving, setMoving] = useState(false);
  const keep = useCallback((next: Place) => {
    setPlace(next);
    try { localStorage.setItem(`ares.surface.place.${name}`, JSON.stringify(next)); } catch { /* it just will not be remembered */ }
  }, [name]);
  const drag = useCallback((dx: number, dy: number, done: boolean) => {
    const el = box.current;
    if (!el || done) return;
    const r = el.getBoundingClientRect();
    // The app may run zoomed: CSS lengths and screen pixels are not the same size.
    const zoom = r.width / (el.offsetWidth || r.width) || 1;
    const x = r.left / zoom + dx / zoom, y = r.top / zoom + dy / zoom;
    const wide = innerWidth / zoom, tall = innerHeight / zoom;
    // A bit of it always stays in reach, so it can never be dragged away for good.
    keep({ left: Math.min(wide - 80, Math.max(80 - el.offsetWidth, x)), top: Math.min(tall - 40, Math.max(0, y)), width: el.offsetWidth, height: el.offsetHeight, of: shape });
  }, [keep, shape]);
  const grab = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const bar = event.currentTarget;
    bar.setPointerCapture(event.pointerId);
    setMoving(true);
    let x = event.clientX, y = event.clientY;
    const move = (e: PointerEvent) => { drag(e.clientX - x, e.clientY - y, false); x = e.clientX; y = e.clientY; };
    const up = () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); setMoving(false); };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  };
  // The corner handle resizes the box itself; the new size is kept the same way.
  useEffect(() => {
    const el = box.current;
    if (!el || !movable || hidden) return;
    // Its first report is only its starting size.
    let first = true;
    const seen = new ResizeObserver(() => {
      if (first) { first = false; return; }
      const width = el.offsetWidth, height = el.offsetHeight;
      if (width < 1 || height < 1) return;
      const r = el.getBoundingClientRect();
      const zoom = r.width / width || 1;
      setPlace((cur) => {
        if (cur && Math.abs(cur.width - width) < 1 && Math.abs(cur.height - height) < 1) return cur;
        const next = { left: r.left / zoom, top: r.top / zoom, width, height, of: shape };
        try { localStorage.setItem(`ares.surface.place.${name}`, JSON.stringify(next)); } catch { /* it just will not be remembered */ }
        return next;
      });
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [movable, hidden, name, shape]);
  const where = place ? { left: place.left, top: place.top, width: place.width, height: place.height, right: "auto", bottom: "auto" } : {};
  return (
    <div ref={box} className={`freeSurface${movable ? " movable" : ""}${web ? " web" : ""}${moving ? " moving" : ""}`} style={{ right: 24, bottom: 24, width: web ? "min(820px, 72vw)" : 360, height: web ? "min(520px, 72vh)" : 280, ...base.style, ...live.style, ...where, pointerEvents: clickThrough ? "none" : undefined, display: hidden ? "none" : undefined } as React.CSSProperties}>
      {web ? (
        <div className="freeBar" onPointerDown={grab}>
          <b>{vm.document.title || name}</b>
          <button type="button" aria-label={`Reload ${vm.document.title || name}`} onClick={() => { reloadKey.current += 1; reload(); }}>Reload</button>
          <button type="button" aria-label={`Close ${vm.document.title || name}`} onClick={() => setSurfaceVisibility(name, "hide")}>Close</button>
        </div>
      ) : movable ? <div className="freeGrip" onPointerDown={grab} aria-hidden="true" /> : null}
      {/* A closed website is gone, not hidden: a hidden page keeps playing, and a
          closed one must not load at every start. */}
      {web && hidden ? null : <SurfaceHost key={reloadKey.current} name={name} document={vm.document} revision={vm.manifest.revision} morph={vm.morph} transparent={transparent} onFrame={onFrame} onDrag={movable ? drag : undefined} onClose={onClose} onIntent={onIntent} onFault={onFault} onCall={onCall} className="freeFrame" />}
    </div>
  );
}

export function FreeSurfaces() {
  const { surfaces } = useSurfaces();
  const api = useSurfaces();
  const free = useMemo(() => Object.values(surfaces).filter((s) => s.manifest.placement === "free"), [surfaces]);
  // A surface placed anywhere else has its own way of opening: a pane, a tab,
  // an OS window outside Ares.
  useEffect(() => subscribeSurfaceVisibility((name, op) => {
    const placement = api.surfaces[name]?.manifest.placement;
    if (!placement || placement === "free" || placement.startsWith("at:")) return;
    if (placement !== "window") { if (op !== "hide") api.open(name); return; }
    if (op === "show") { api.open(name); return; }
    void invoke<boolean>("ares_surface_window_close", { name }).then((closed) => { if (!closed && op === "toggle") api.open(name); }).catch(() => null);
  }), [api]);
  return <>{free.map((vm) => <Free key={vm.manifest.name} vm={vm} />)}</>;
}

/** What the app looks like right now, for Ares to place things: every
 * distinct class, id and labelled control on screen. */
export function readUiMap(): string[] {
  const seen = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (el.closest("[data-anchor-host]") || el.tagName === "IFRAME" || el.tagName === "svg" || el.closest("svg")) continue;
    if (el.id) seen.add(`#${el.id}`);
    for (const cls of Array.from(el.classList)) seen.add(`.${cls}`);
    const label = el.getAttribute("aria-label");
    if (label && label.length <= 60) seen.add(`[aria-label="${label}"]`);
    // Only a selector that really matches: a titled button is not labelled.
    const title = el.tagName === "BUTTON" ? el.getAttribute("title") : null;
    if (title && title.length <= 60) seen.add(`[title="${title}"]`);
    if (seen.size >= 600) break;
  }
  return [...seen];
}

/** What Ares needs to restyle from scratch instead of guessing: the real
 * colours of everything visible, by selector, and the live tokens. */
export function readUiStyles(): { styles: string[]; vars: Record<string, string> } {
  const seen = new Set<string>();
  const styles: string[] = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (styles.length >= 320) break;
    if (el.tagName === "IFRAME" || el.closest("svg") || el.closest("[data-anchor-host]")) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const key = el.classList[0] ? `.${el.classList[0]}` : el.tagName.toLowerCase();
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor === "rgba(0, 0, 0, 0)" ? (cs.backgroundImage !== "none" ? "image" : "") : cs.backgroundColor;
    const border = cs.borderTopWidth !== "0px" ? cs.borderTopColor : "";
    const text = el.children.length === 0 && el.textContent?.trim() ? cs.color : "";
    if (!bg && !border && !text) continue;
    const row = `${key}${bg ? ` bg ${bg}` : ""}${text ? ` text ${text}` : ""}${border ? ` border ${border}` : ""}`;
    if (seen.has(row)) continue;
    seen.add(row);
    styles.push(row);
  }
  const vars: Record<string, string> = {};
  const root = document.querySelector(".ares");
  if (root) {
    const cs = getComputedStyle(root);
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        const style = (rule as CSSStyleRule).style;
        if (!style) continue;
        for (const prop of Array.from(style)) {
          if (prop.startsWith("--") && !(prop in vars) && Object.keys(vars).length < 140) {
            const value = cs.getPropertyValue(prop).trim();
            if (value) vars[prop] = value.slice(0, 80);
          }
        }
      }
    }
  }
  return { styles, vars };
}
