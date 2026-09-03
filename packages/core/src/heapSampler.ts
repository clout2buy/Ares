// Heap allocation sampler — attribution for the climb nobody could explain.
//
// The 2026-08-25 artifacts recorded the daemon's heap going 3015→4006MB over
// five idle minutes (zero active turns) and then aborting. Space-level
// diagnostics (memoryGuard.readHeapDiagnostics) say WHERE the bytes sit
// (old space vs new space vs external) but not WHO allocated them, and a full
// heap snapshot of a 4GB heap is a multi-second stop-the-world write of a
// multi-gigabyte file — not something to do on a box that is seconds from an
// abort. V8's sampling heap profiler is the cheap middle: it records a
// Poisson-sampled subset of allocations with their call stacks, at a cost
// that is negligible with a coarse interval, and it can be read WITHOUT
// stopping. So the daemon runs it from boot and the heap-critical artifact
// embeds the top allocation sites — by function/file/line — so the next
// climb names its allocator instead of only its percentage.
//
// Inspector-session protocol calls on the main thread complete synchronously
// (the callback runs before `post` returns), which is what lets the
// heap-watch task — a synchronous plugin job — read the profile inline. The
// async path is kept for hosts that prefer it; both tolerate a session that
// failed to open (profiling is a diagnostic, never a dependency).

import { Session } from "node:inspector";

export interface HeapAllocationSite {
  function: string;
  url: string;
  line: number;
  /** Bytes attributed to this exact frame (self, not inclusive). */
  selfBytes: number;
}

interface SamplingNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: SamplingNode[];
}

/** ARES_HEAP_PROFILE=0 disables the sampler entirely. */
export function heapSamplerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARES_HEAP_PROFILE !== "0";
}

/**
 * Sampling interval in bytes. V8's default is 32KB; 256KB keeps the overhead
 * well under 1% while still resolving anything that can move a 4GB heap.
 */
export function heapSamplerIntervalBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ARES_HEAP_PROFILE_INTERVAL_BYTES);
  return Number.isFinite(raw) && raw >= 4096 ? Math.floor(raw) : 256 * 1024;
}

export class HeapAllocationSampler {
  private session: Session | null = null;
  private lastTop: HeapAllocationSite[] = [];

  /** True when profiling is running. Never throws: a host without inspector
   *  support (or one already attached to a debugger that owns the profiler)
   *  simply has no attribution, and the artifact says so. */
  get active(): boolean {
    return this.session !== null;
  }

  start(intervalBytes: number = heapSamplerIntervalBytes()): boolean {
    if (this.session) return true;
    try {
      const session = new Session();
      session.connect();
      let ok = false;
      session.post("HeapProfiler.enable", (err) => {
        if (err) return;
        session.post("HeapProfiler.startSampling", { samplingInterval: intervalBytes }, (err2) => {
          ok = !err2;
        });
      });
      if (!ok) {
        try { session.disconnect(); } catch { /* best effort */ }
        return false;
      }
      this.session = session;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Top allocation sites by self size, read WITHOUT stopping the profiler.
   * Synchronous by construction (see file header); if the protocol ever
   * answers late the previous reading is returned rather than nothing.
   */
  topSites(limit = 25): HeapAllocationSite[] {
    const session = this.session;
    if (!session) return [];
    let head: SamplingNode | undefined;
    try {
      session.post("HeapProfiler.getSamplingProfile", (err, result) => {
        if (!err) head = (result as { profile?: { head?: SamplingNode } })?.profile?.head;
      });
    } catch {
      return this.lastTop;
    }
    if (!head) return this.lastTop;
    this.lastTop = summarizeSamplingProfile(head, limit);
    return this.lastTop;
  }

  stop(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.post("HeapProfiler.stopSampling", () => undefined);
      session.disconnect();
    } catch {
      // Diagnostic teardown must never fail a shutdown.
    }
  }
}

/**
 * Flatten a sampling-profile tree into per-frame self sizes. The same frame
 * reached through different callers is one row (it is the allocator that
 * matters for "what is growing", and the tree is available raw if a caller
 * ever wants the paths). Anonymous frames keep their file:line so a closure
 * inside a known module is still attributable.
 */
export function summarizeSamplingProfile(head: SamplingNode, limit = 25): HeapAllocationSite[] {
  const byFrame = new Map<string, HeapAllocationSite>();
  const stack: SamplingNode[] = [head];
  let visited = 0;
  while (stack.length > 0 && visited < 200_000) {
    const node = stack.pop()!;
    visited++;
    if (node.selfSize > 0) {
      const frame = node.callFrame ?? { functionName: "", url: "", lineNumber: -1 };
      const key = `${frame.url}\u0000${frame.lineNumber}\u0000${frame.functionName}`;
      const row = byFrame.get(key);
      if (row) row.selfBytes += node.selfSize;
      else {
        byFrame.set(key, {
          function: frame.functionName || "(anonymous)",
          url: shortUrl(frame.url),
          line: frame.lineNumber + 1,
          selfBytes: node.selfSize,
        });
      }
    }
    if (node.children) for (const child of node.children) stack.push(child);
  }
  return [...byFrame.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, limit);
}

/** `file:///D:/Ares/packages/core/dist/x.js` → `packages/core/dist/x.js`; node
 *  internals keep their `node:` prefix. Short enough for an artifact line. */
function shortUrl(url: string): string {
  if (!url) return "(native)";
  const idx = url.indexOf("/packages/");
  if (idx >= 0) return url.slice(idx + 1);
  return url.replace(/^file:\/\/\/?/, "");
}
