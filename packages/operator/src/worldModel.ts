// The WorldModel — reality, re-derived (Crix v5 / O3 / concept C1 rule #2).
//
// "Trust reality, never your memory of acting on it." The WorldModel holds a
// set of named sources (each a probe) and, on every refresh(), re-runs them to
// produce a fresh snapshot of the world plus a combined fingerprint. It never
// reads the action log to decide what's true — it asks reality directly. The
// fingerprint lets the control loop (and idle maintenance) cheaply notice when
// the world has actually changed.

import { runProbe, type ProbeResult } from "./probe.js";
import type { VerificationSpec } from "./types.js";

export interface WorldSource {
  name: string;
  spec: VerificationSpec;
}

export interface WorldSnapshot {
  at: string;
  sources: Record<string, ProbeResult>;
  /** Stable over an unchanged world; changes the moment any source changes. */
  fingerprint: string;
}

export class WorldModel {
  constructor(
    private readonly sources: WorldSource[],
    private readonly opts: { workspace?: string } = {},
  ) {}

  /** Re-derive the whole world from its sources. Reality, not memory. */
  async refresh(signal?: AbortSignal): Promise<WorldSnapshot> {
    const results: Record<string, ProbeResult> = {};
    for (const source of this.sources) {
      results[source.name] = await runProbe(source.spec, { workspace: this.opts.workspace, signal });
    }
    const fingerprint = this.sources
      .map((s) => `${s.name}=${results[s.name].fingerprint ?? results[s.name].met}`)
      .join("|");
    return { at: new Date().toISOString(), sources: results, fingerprint };
  }

  names(): string[] {
    return this.sources.map((s) => s.name);
  }
}
