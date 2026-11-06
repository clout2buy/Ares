// Posts flow from the daemon (feeds, Ares's replies, call results) into
// whichever host has the surface mounted. A surface may be mounted nowhere
// (its pane is closed) when a post arrives; the last few wait for it.

type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, unknown[]>();
const PENDING_CAP = 50;

export function deliverSurfacePost(name: string, payload: unknown): void {
  const set = listeners.get(name);
  if (set && set.size) {
    for (const fn of set) {
      try { fn(payload); } catch { /* a host that throws must not stop the others */ }
    }
    return;
  }
  const queue = pending.get(name) ?? [];
  queue.push(payload);
  pending.set(name, queue.slice(-PENDING_CAP));
}

export function subscribeSurfacePosts(name: string, fn: Listener): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(fn);
  const queued = pending.get(name);
  if (queued?.length) {
    pending.delete(name);
    for (const payload of queued) fn(payload);
  }
  return () => {
    set?.delete(fn);
    if (set && !set.size) listeners.delete(name);
  };
}

/** One surface shared something: every other mounted one hears it. */
export function deliverSurfaceShare(from: string, topic: string, data: unknown): void {
  for (const [name, set] of listeners) {
    if (name === from) continue;
    for (const fn of set) {
      try { fn({ __share: 1, topic, data, from }); } catch { /* keep going */ }
    }
  }
}

export function forgetSurfacePosts(name: string): void {
  pending.delete(name);
}

/** What each document last said it draws, for the landing report. */
const contents = new Map<string, { box: [number, number, number, number]; frame: [number, number] }>();

export function noteSurfaceContent(name: string, box: [number, number, number, number], frame: [number, number]): void {
  contents.set(name, { box, frame });
}

export function surfaceContent(name: string): { box: [number, number, number, number]; frame: [number, number] } | undefined {
  return contents.get(name);
}

/** Open and closed, for ares.show / hide / toggle. Lives here so any surface can
 * reach any other without either knowing how the other is placed. */
export type VisibilityOp = "show" | "hide" | "toggle";
const hiddenNow = new Map<string, boolean>();
const visibilityListeners = new Set<(name: string, op: VisibilityOp) => void>();

export function surfaceIsHidden(name: string): boolean {
  return hiddenNow.get(name) ?? false;
}

export function declareSurfaceHidden(name: string, hidden: boolean): void {
  if (!hiddenNow.has(name)) hiddenNow.set(name, hidden);
}

export function setSurfaceVisibility(name: string, op: VisibilityOp): void {
  hiddenNow.set(name, op === "hide" ? true : op === "show" ? false : !surfaceIsHidden(name));
  for (const fn of visibilityListeners) fn(name, op);
}

export function subscribeSurfaceVisibility(fn: (name: string, op: VisibilityOp) => void): () => void {
  visibilityListeners.add(fn);
  return () => { visibilityListeners.delete(fn); };
}
