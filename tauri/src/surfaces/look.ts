// Answers the daemon's "what do you actually see": a report of where every
// surface landed and a real screenshot of the window.

import { invoke } from "@tauri-apps/api/core";
import type { SurfaceVm } from "./SurfacesContext";
import { surfaceContent, surfaceIsHidden } from "./postBus";
import { pokeElement } from "./SurfaceHost";

interface Act { selector?: string; text?: string; key?: string; probe?: { x: number; y: number }; scan?: "light" | "dark" }

function brightness(value: string): number | null {
  const named = /\b(white|whitesmoke|snow|ivory)\b/i.test(value) ? 255 : null;
  if (named !== null) return named;
  const levels: number[] = [];
  for (const m of value.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    levels.push(0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16));
  }
  for (const m of value.matchAll(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+%?))?/gi)) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (alpha >= 0.12) levels.push(0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]);
  }
  return levels.length ? Math.max(...levels) : null;
}

/** Every rule that paints that way, on screen or not: menus and dialogs never
 * show up in a screenshot of the screen they are closed on. Rules for a theme
 * that is not the one running are left out. */
function scanColors(find: "light" | "dark"): string {
  const root = document.querySelector(".ares");
  const rows = new Set<string>();
  const applies = (selector: string) => {
    const lead = selector.trim().split(/\s|>/)[0] ?? "";
    if (!root || !/\.ares|\[data-/.test(lead)) return true;
    try { return root.matches(lead.replace(/::?(before|after)\b.*/, "")) || document.documentElement.matches(lead) || document.body.matches(lead); } catch { return true; }
  };
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if ("cssRules" in rule && !(rule instanceof CSSStyleRule)) { walk((rule as CSSGroupingRule).cssRules); continue; }
      if (!(rule instanceof CSSStyleRule)) continue;
      const paint = rule.style.getPropertyValue("background") || rule.style.getPropertyValue("background-color") || rule.style.getPropertyValue("background-image");
      if (!paint) continue;
      const level = brightness(paint);
      if (level === null || (find === "light" ? level < 170 : level > 80)) continue;
      const selectors = rule.selectorText.split(",").filter(applies).map((s) => s.trim());
      if (selectors.length) rows.add(`${selectors.slice(0, 3).join(", ").slice(0, 90)} {${paint.slice(0, 50)}}`);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    // The look already applied is not part of what still needs changing.
    if ((sheet.ownerNode as Element | null)?.id === "ares-shell-layout") continue;
    try { walk(sheet.cssRules); } catch { /* not readable */ }
  }
  const all = Array.from(rows);
  return `${all.length} rules paint a ${find} background, on screen or not. Some may already be overridden:\n${all.slice(0, 220).join("\n")}`;
}

function selectorText(el: Element): string {
  const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes.map((c) => `.${c}`).join("")}`;
}

/** The app's own rules that paint this element, last declared last. */
function paintingRules(el: Element, pseudo: string | null): string[] {
  const found: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if ("cssRules" in rule && !(rule instanceof CSSStyleRule)) { walk((rule as CSSGroupingRule).cssRules); continue; }
      if (!(rule instanceof CSSStyleRule)) continue;
      const paint = rule.style.getPropertyValue("background") || rule.style.getPropertyValue("background-color") || rule.style.getPropertyValue("background-image");
      if (!paint) continue;
      for (const part of rule.selectorText.split(",")) {
        const hasPseudo = /::?(before|after)\b/.test(part);
        if (hasPseudo !== Boolean(pseudo) || (pseudo && !part.includes(pseudo.slice(2)))) continue;
        try {
          if (el.matches(part.replace(/::?(before|after)\b/, "") || "*")) {
            found.push(`${part.trim()} {${paint.slice(0, 60)}${rule.style.getPropertyPriority("background") || rule.style.getPropertyPriority("background-color") ? " !important" : ""}}`);
          }
        } catch { /* a selector this engine cannot match */ }
        break;
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { walk(sheet.cssRules); } catch { /* not readable */ }
  }
  return found.slice(-3);
}

/** Every layer that paints one pixel, top first: what a colour change has to beat. */
function paintAt(x: number, y: number): string {
  const scale = devicePixelRatio || 1;
  const rows: string[] = [];
  for (const el of document.elementsFromPoint(x / scale, y / scale).slice(0, 10)) {
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      if (pseudo && (cs.content === "none" || cs.content === "normal")) continue;
      const paint = [
        cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? cs.backgroundColor : "",
        cs.backgroundImage !== "none" ? cs.backgroundImage.slice(0, 90) : "",
        cs.backdropFilter && cs.backdropFilter !== "none" ? `backdrop ${cs.backdropFilter}` : "",
      ].filter(Boolean);
      if (!paint.length) continue;
      const rules = paintingRules(el, pseudo);
      rows.push(`${selectorText(el)}${pseudo ?? ""}: ${paint.join(" + ")}${rules.length ? `\n  rules: ${rules.join(" | ")}` : ""}`);
    }
  }
  return rows.length ? `Painting ${x},${y}, top layer first:\n${rows.join("\n")}` : `Nothing paints ${x},${y} but the window itself.`;
}

/** Does it in the document that owns the element, and says what happened. */
function act(surface: string | undefined, what: { selector: string; text?: string; key?: string }): Promise<string> {
  if (!surface) return Promise.resolve(pokeElement(document, what));
  const frame = document.querySelector<HTMLIFrameElement>(`iframe.surfaceFrame[data-surface="${CSS.escape(surface)}"]`);
  if (!frame?.contentWindow) return Promise.resolve(`${surface} is not on screen, so nothing was tried`);
  return new Promise((resolve) => {
    const done = (result: string) => { window.removeEventListener("message", onMessage); clearTimeout(timer); resolve(result); };
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.contentWindow && event.data?.__ares === 1 && event.data.type === "poked") done(String(event.data.result));
    };
    const timer = setTimeout(() => done(`${surface} did not answer`), 1500);
    window.addEventListener("message", onMessage);
    frame.contentWindow!.postMessage({ __ares: 1, type: "poke", act: what }, "*");
  });
}

function describe(el: Element): string {
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return el.id ? `#${el.id}` : cls ? `.${cls}` : el.tagName.toLowerCase();
}

function landing(vm: SurfaceVm): string {
  const { name, placement } = vm.manifest;
  if (placement === "window") return `${name}: in its own OS window.`;
  if (placement === "phone" || placement === "telegram") return `${name}: on ${placement}, not in this window.`;
  if (surfaceIsHidden(name)) return `${name}: hidden until ares.show or ares.toggle opens it.`;
  const frame = document.querySelector<HTMLIFrameElement>(`iframe.surfaceFrame[data-surface="${CSS.escape(name)}"]`);
  const at = /^at:[a-z]+:([\s\S]+)$/.exec(placement);
  if (!frame) {
    if (at) {
      let found = false;
      try { found = Boolean(document.querySelector(at[1])); } catch { /* bad selector */ }
      return `${name}: PROBLEM not on screen, ${found ? "its target exists but nothing rendered" : `nothing matches ${at[1]}`}.`;
    }
    return `${name}: not on screen (${placement}, shows when that view opens).`;
  }
  const box = frame.getBoundingClientRect();
  const lines = [`${name}: ${placement} at x${Math.round(box.left)} y${Math.round(box.top)}, ${Math.round(box.width)}x${Math.round(box.height)}`];
  const seenW = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0));
  const seenH = Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
  const area = box.width * box.height;
  const seen = area > 0 ? Math.round((seenW * seenH / area) * 100) : 0;
  if (area === 0) lines.push("PROBLEM it has no size");
  else if (seen < 100) lines.push(`PROBLEM only ${seen}% is inside the window`);
  if (seen > 0 && vm.manifest.frame?.clickThrough !== true) {
    const top = document.elementFromPoint(Math.min(box.left + box.width / 2, innerWidth - 1), Math.min(box.top + box.height / 2, innerHeight - 1));
    // Behind Settings or another dialog is the app working normally.
    if (top && top !== frame) lines.push(top.closest(".scrim") ? "behind the dialog that is open" : `PROBLEM covered by ${describe(top)}`);
  }
  const content = surfaceContent(name);
  if (content) {
    const [l, t, r, b] = content.box;
    const [w, h] = content.frame;
    if (l < -1 || t < -1 || r > w + 1 || (b > h + 1 && /^(at:|free)/.test(placement))) {
      lines.push(`PROBLEM its content spans ${Math.round(r - l)}x${Math.round(b - t)} but a frame clips at ${Math.round(w)}x${Math.round(h)}, so part of it can never be seen`);
    }
  }
  const fault = vm.faults[vm.faults.length - 1];
  if (fault) lines.push(`PROBLEM script fault: ${fault}${/storage|SecurityError/i.test(fault) ? " (a surface has no browser storage: use ares.store)" : ""}`);
  return `${lines.join("; ")}.`;
}

/** What the owner cannot lose: without these they are locked out of their app. */
function reachable(): string[] {
  const lost: string[] = [];
  const check = (el: Element | null, what: string) => {
    if (!el) return;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const invisible = style.visibility !== "visible" || Number(style.opacity) < 0.2;
    // A dialog over everything is the app working normally, not something lost.
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    // A panel the owner can drag aside or close is not a lockout either.
    const covered = !invisible && !document.querySelector(".scrim") && !el.contains(hit) && !hit?.closest(".freeSurface.movable");
    if (invisible || covered || box.width < 4 || box.height < 4 || box.top >= innerHeight - 4 || box.bottom <= 4 || box.left >= innerWidth - 4 || box.right <= 4) lost.push(`PROBLEM ${what}`);
  };
  // Other tabs hide the chat, message box and all, which is not something lost.
  const onOtherTab = document.querySelector('.msTab[data-on="1"]:not([title="Chats"])');
  if (!onOtherTab) check(document.querySelector(".composer textarea"), "the message box is off screen, so the owner cannot type: fix this before anything else");
  check(document.querySelector(".msGenui"), "the GenUI button is gone, so the owner cannot turn GenUI off");
  return lost;
}

export function readLanding(surfaces: Record<string, SurfaceVm>, focus?: string): string {
  const all = Object.values(surfaces);
  const rows = all.map((vm) => ({ vm, text: landing(vm) }));
  // The surface just touched, then anything wrong; the rest would only be noise.
  const shown = rows.filter((row) => row.vm.manifest.name === focus || row.text.includes("PROBLEM"));
  const window = `Window ${innerWidth}x${innerHeight}${devicePixelRatio !== 1 ? `, screenshot at ${devicePixelRatio}x` : ""}.`;
  const fault = (globalThis as { __aresShellFault?: string | null }).__aresShellFault;
  const lost = [...(fault ? [`PROBLEM the Shell script did not run: ${fault.slice(0, 300)}`] : []), ...reachable()];
  if (!shown.length && !lost.length) return `${window} ${all.length ? `${all.length} surface(s), none with a problem.` : "No surfaces."}`;
  return [window, ...lost, ...shown.map((row) => row.text)].join("\n");
}

async function capture(label: string | null): Promise<string | null> {
  try {
    // Only the dev bridge reads this; the native capture needs no rectangle.
    const rect = { x: window.screenX + window.outerWidth - innerWidth, y: window.screenY, width: innerWidth, height: innerHeight, scale: devicePixelRatio };
    return await invoke<string | null>("ares_capture_view", { label, rect });
  } catch {
    return null;
  }
}

/** The open tab and every surface showing, to say what a click really did. */
function onScreen(): { tab: string; open: Set<string> } {
  const open = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe.surfaceFrame[data-surface]")).filter((f) => {
    const box = f.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }).map((f) => f.dataset.surface ?? "");
  return { tab: document.querySelector('.msTab[data-on="1"]')?.getAttribute("title") ?? "", open: new Set(open) };
}

function changed(a: ReturnType<typeof onScreen>, b: ReturnType<typeof onScreen>): string[] {
  const opened = [...b.open].filter((n) => !a.open.has(n));
  const closed = [...a.open].filter((n) => !b.open.has(n));
  return [
    ...(opened.length ? [`That opened ${opened.join(", ")}.`] : []),
    ...(closed.length ? [`That closed ${closed.join(", ")}.`] : []),
    ...(a.tab !== b.tab && b.tab ? [`Now on the ${b.tab} tab.`] : []),
  ];
}

export async function answerLook(id: string, surfaces: Record<string, SurfaceVm>, focus: string | undefined, what: Act | undefined, send: (command: Record<string, unknown>) => void): Promise<void> {
  if (what?.probe || what?.scan) {
    const report = what.probe ? paintAt(what.probe.x, what.probe.y) : scanColors(what.scan as "light" | "dark");
    send({ type: "ui_seen", callId: id, input: { report, images: [] } });
    return;
  }
  const before = onScreen();
  const did = what?.selector ? await act(focus, { ...what, selector: what.selector }) : "";
  // Long enough for what it did to finish arriving on screen.
  if (what) await new Promise((resolve) => setTimeout(resolve, 650));
  const report = [did, ...(did ? changed(before, onScreen()) : []), readLanding(surfaces, focus)].filter(Boolean).join("\n");
  const shots = [await capture(null)];
  if (focus && surfaces[focus]?.manifest.placement === "window") shots.push(await capture(`surface-${focus}`));
  const images = shots.filter((s): s is string => Boolean(s)).map((data) => ({ mediaType: "image/jpeg", data }));
  send({ type: "ui_seen", callId: id, input: { report, images } });
}
