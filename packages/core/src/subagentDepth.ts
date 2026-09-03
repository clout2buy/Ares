// Subagent nesting depth.
//
// A `general-purpose` child inherits Task, so without a cap a child can spawn
// a child that spawns a child — unbounded fan-out with no owner in the loop.
// The depth rides AsyncLocalStorage: the runner enters `runAtSubagentDepth`
// around every child turn, so a Task invoked from INSIDE that turn (through
// the same shared Task tool object) sees its depth without every host having
// to thread a number through tool contexts. Explicit `depth` on a run request
// still wins (durable background jobs persist it across restarts).
//
// ARES_SUBAGENT_MAX_DEPTH — max nesting (default 1: children cannot spawn).

import { AsyncLocalStorage } from "node:async_hooks";

const depthStore = new AsyncLocalStorage<number>();

export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;

/** Tools that spawn further engines — scoped out of a child at the cap. */
export const SUBAGENT_SPAWNING_TOOLS: ReadonlySet<string> = new Set(["Task", "Conductor", "CodingBackend"]);

export function subagentMaxDepth(): number {
  const raw = Number(process.env.ARES_SUBAGENT_MAX_DEPTH);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_SUBAGENT_MAX_DEPTH;
}

/** 0 at a top-level session; N inside the N-th nested child turn. */
export function currentSubagentDepth(): number {
  return depthStore.getStore() ?? 0;
}

export function runAtSubagentDepth<T>(depth: number, fn: () => Promise<T>): Promise<T> {
  return depthStore.run(depth, fn);
}
