// Ares's eyes on its own window. A tool asks, the desktop answers with a real
// screenshot and a report of where each surface landed. Every Surface and Shell
// change comes back with both while GenUI is on: a model that cannot see what
// it built cannot tell whether it is any good.

import type { ToolResult } from "./_shared.js";
import { genuiEnabled } from "./genui.js";

export interface UiLook {
  report: string;
  images: Array<{ mediaType: string; data: string }>;
}

/** Something to do in the UI before looking: click, type or press a key. */
export interface UiAct {
  selector?: string;
  text?: string;
  key?: string;
  /** Instead of acting: name every layer painting this pixel of the screenshot. */
  probe?: { x: number; y: number };
  /** Instead of acting: every rule painting a light or dark background, on screen or not. */
  scan?: "light" | "dark";
}

type Requester = (id: string, surface?: string, act?: UiAct) => void;

let requester: Requester | null = null;
let seq = 0;
const pending = new Map<string, (look: UiLook | null) => void>();

export function setLookRequester(fn: Requester | null): void {
  requester = fn;
}

export function answerLook(id: string, look: UiLook): void {
  pending.get(id)?.(look);
  pending.delete(id);
}

/** Null when no desktop is attached or it did not answer in time. */
export function lookAtUi(surface?: string, timeoutMs = 7_000, act?: UiAct): Promise<UiLook | null> {
  const ask = requester;
  if (!ask) return Promise.resolve(null);
  seq += 1;
  const id = `look_${Date.now().toString(36)}_${seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, (look) => { clearTimeout(timer); resolve(look); });
    ask(id, surface, act);
  });
}

/** Lets a surface finish loading and arriving before the picture is taken. */
const SETTLE_MS = 900;

export async function withEyes<O extends { message: string }>(result: ToolResult<O>, surface?: string): Promise<ToolResult<O>> {
  if (!requester || !genuiEnabled()) return result;
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const look = await lookAtUi(surface);
  if (!look) return result;
  const seen = look.images.length
    ? "The attached screenshot is the real window right now. Judge it as the owner would: is it there, does it belong next to what surrounds it, is anything clipped, covered or ugly? If not, fix it and check again before replying. Keep working on your own until it is done: do not ask the owner whether to continue."
    : "No screenshot is available here, so this report is all you can see.";
  return {
    ...result,
    output: { ...result.output, message: `${result.output.message}\n\nOn screen now:\n${look.report}\n${seen}` },
    ...(look.images.length ? { images: look.images } : {}),
  };
}
