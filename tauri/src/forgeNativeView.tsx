// The Forge's native browser view, placed over the Live stage.
//
// Owner, 2026-10-20: "never a screenshot again… every site can load in ares
// preview, I can actually log in on its preview." The page is a real child
// webview (src-tauri/src/forge_view.rs), not an iframe and not a stream of
// frames, so no site can refuse it and the owner types, scrolls and signs in
// for real. The daemon's Browser tool drives the SAME page over CDP.
//
// A native view draws ABOVE the app's HTML, so this component only owns
// geometry: it follows the stage's rect, and steps aside (hides) whenever
// the stage is not showing or something of the app's own (a dialog, the
// palette, the Forge drawer) covers it — otherwise that UI would sit
// invisibly under the page.
import React, { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** App UI that may overlap the stage. Anything else that floats over the
 *  Forge can opt in with data-covers-forge. */
const COVERS = '[role="dialog"], .paletteScrim, .backdrop, .forgeDrawer, .authModal, [data-covers-forge]';

/** Does anything of the app's own sit over this rect right now? */
function covered(stage: DOMRect): boolean {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(COVERS))) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    if (r.right > stage.left && r.left < stage.right && r.bottom > stage.top && r.top < stage.bottom) return true;
  }
  return false;
}

/** Native views open http(s) only (forge_view.rs); other targets stay framed.
 *  about:blank is the daemon waking the view before it drives it. */
export function forgeNativeTarget(url: string): boolean {
  return /^https?:\/\//i.test(url.trim()) || url.trim() === "about:blank";
}

export function ForgeNativeView(props: {
  url: string;
  /** Bumped by the toolbar's reload and by Ares's edits to a served file. */
  revision: number;
  /** Ares already drove the page to url over CDP: show it, don't load it again. */
  driven?: boolean;
  /** The Forge is open on the Live tab. */
  visible: boolean;
  onNav?: (url: string, loading: boolean) => void;
  onTitle?: (title: string) => void;
  onError?: (message: string) => void;
}): React.ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const sentUrl = useRef<string | null>(null);
  const shown = useRef<string>("");
  const visibleRef = useRef(props.visible);
  visibleRef.current = props.visible;
  const urlRef = useRef(props.url);
  urlRef.current = props.url;
  const drivenRef = useRef(Boolean(props.driven));
  drivenRef.current = Boolean(props.driven);
  const cb = useRef(props);
  cb.current = props;

  // Geometry: follow the stage, hide when it isn't showing or is covered.
  // Calls go out only when something changed, so the 250 ms poll (sidebar
  // and rail animations move the stage without any resize event) is cheap.
  useEffect(() => {
    let alive = true;
    const place = () => {
      const el = stageRef.current;
      if (!alive || !el) return;
      const r = el.getBoundingClientRect();
      const show = visibleRef.current && document.visibilityState === "visible" && r.width > 8 && r.height > 8 && !covered(r);
      const url = urlRef.current;
      const nav = url !== sentUrl.current;
      const key = show ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : "hidden";
      if (key === shown.current && !(show && nav)) return;
      shown.current = key;
      if (!show) { void invoke("ares_forge_view_hide").catch(() => undefined); return; }
      if (nav) sentUrl.current = url;
      void invoke("ares_forge_view_show", { url: nav ? url : null, navigate: !drivenRef.current, x: r.left, y: r.top, w: r.width, h: r.height })
        .catch((err) => { sentUrl.current = null; shown.current = ""; cb.current.onError?.(err instanceof Error ? err.message : String(err)); });
    };
    place();
    const el = stageRef.current;
    const ro = el ? new ResizeObserver(place) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", place);
    document.addEventListener("visibilitychange", place);
    const poll = window.setInterval(place, 250);
    return () => {
      alive = false;
      ro?.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("visibilitychange", place);
      window.clearInterval(poll);
      shown.current = "";
      void invoke("ares_forge_view_hide").catch(() => undefined);
    };
  }, []);

  // A new target or visibility change: place right away, not on the next tick.
  useEffect(() => { shown.current = ""; }, [props.url, props.visible]);

  // Reload on revision bumps (not on the first render: that load is the open).
  const firstRevision = useRef(props.revision);
  useEffect(() => {
    if (props.revision === firstRevision.current) return;
    void invoke("ares_forge_view_control", { action: "reload" }).catch(() => undefined);
  }, [props.revision]);

  useEffect(() => {
    const offs: Array<() => void> = [];
    let alive = true;
    void listen<{ url: string; loading: boolean }>("forge-view-nav", (e) => cb.current.onNav?.(e.payload.url, e.payload.loading)).then((off) => { if (alive) offs.push(off); else off(); });
    void listen<{ title: string }>("forge-view-title", (e) => cb.current.onTitle?.(e.payload.title)).then((off) => { if (alive) offs.push(off); else off(); });
    return () => { alive = false; for (const off of offs) off(); };
  }, []);

  return <div ref={stageRef} className="forgeNativeStage" aria-label="Live page" />;
}

export function forgeViewControl(action: "back" | "forward" | "reload" | "stop"): void {
  void invoke("ares_forge_view_control", { action }).catch(() => undefined);
}
