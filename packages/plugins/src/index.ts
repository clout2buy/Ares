// The Ares plugin kernel: capabilities that can be mounted, unmounted, and
// hot-swapped at runtime, with every side effect rolled back on removal.
//
// Why this exists: Ares keeps growing surfaces that arrive and leave while the
// daemon runs — skills, connectors, personas, belt tools, self-built
// extensions. Each one grew a bespoke lifecycle, and every bespoke lifecycle
// grew bespoke leaks: listeners that outlive their owner, registries that only
// ever add, "disable" flags that leave the wiring in place. The kernel makes
// removal a first-class operation with two properties (the same pair DeepSeek's
// Cordis formalizes as spatiotemporal composability, built here natively so a
// three-week-old v0.1 dependency never sits under the daemon):
//
//   1. TEMPORAL: everything a plugin registers — effects, services, event
//      listeners — disappears with it, torn down in reverse registration
//      order. Unmount is provably the inverse of mount.
//   2. SPATIAL: a plugin declares the services it needs (`inject`); it
//      activates only when they exist and deactivates BEFORE they vanish.
//      The running state depends only on WHICH plugins are mounted, never on
//      the order they arrived or left in (path independence) — which is what
//      makes hot reload safe.
//
// Deliberately small: no profiles, no bundles, no config reconciler. Those can
// layer on top once the daemon's extension surfaces actually live here.

export interface PluginContext {
  /** The mounting plugin's name — for diagnostics and error attribution. */
  readonly pluginName: string;
  /**
   * Register a reversible side effect. The cleanup runs on unmount (or on
   * setup failure), in reverse registration order — RAII at runtime. Anything
   * a plugin changes in the outside world belongs behind one of these.
   *
   * Cleanups may be async: real tenants tear down real things (child
   * processes, servers, token revocations), and a fire-and-forget teardown is
   * exactly the bespoke-lifecycle leak this kernel exists to kill. Each
   * cleanup is awaited before the one beneath it runs, so reverse order holds
   * across await points too.
   */
  effect(cleanup: () => void | Promise<void>): void;
  /**
   * Provide a named service for other plugins. Removed automatically on
   * unmount — after every dependent has deactivated. A name can have only one
   * live provider; a second provider is a setup error, not a silent shadow.
   */
  provide<T>(name: string, service: T): void;
  /** Read a service. Undefined when absent — prefer `inject` for hard needs. */
  service<T>(name: string): T | undefined;
  /** Subscribe to the host bus; the subscription dies with the plugin. */
  on(event: string, handler: (payload: unknown) => void): void;
  /** Emit on the host bus. Listener errors are contained, never propagated. */
  emit(event: string, payload?: unknown): void;
}

export interface AresPlugin<C = unknown> {
  name: string;
  /** Services whose presence gates activation (spatial dependency). */
  inject?: readonly string[];
  /** Runs on activation. Register every side effect via ctx — a throw rolls
   *  back whatever was registered so far and marks the plugin failed. */
  setup(ctx: PluginContext, config: C): void | Promise<void>;
}

export type PluginState = "pending" | "active" | "failed";

export interface PluginStatus {
  name: string;
  state: PluginState;
  /** Missing inject dependencies (why a pending plugin is pending). */
  waitingOn: string[];
  /** The setup failure, when state is "failed". */
  error?: string;
}

interface PluginRecord {
  plugin: AresPlugin<unknown>;
  config: unknown;
  state: PluginState;
  error?: string;
  /** Reverse-order teardown stack: effects, service removals, listener drops. */
  cleanups: Array<() => void | Promise<void>>;
  /** Services this record currently provides (for dependency bookkeeping). */
  provides: Set<string>;
  /** Monotonic stamp so cascades deactivate newest-first. */
  activatedAt: number;
}

/** Lifecycle events the host itself emits on its bus. */
export const HOST_EVENTS = {
  activated: "plugin/activated",
  deactivated: "plugin/deactivated",
  failed: "plugin/failed",
} as const;

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly services = new Map<string, { value: unknown; owner: string }>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** All mutating operations serialize through this chain — a mount arriving
   *  while another plugin's async setup runs must observe its outcome, not
   *  interleave with it. */
  private ops: Promise<void> = Promise.resolve();
  private activationClock = 0;
  private disposed = false;

  /**
   * Mount a plugin. It activates immediately when its `inject` services all
   * exist, otherwise parks pending and activates the moment they do. Returns
   * the plugin's state after the host settles.
   */
  mount<C>(plugin: AresPlugin<C>, config?: C): Promise<PluginStatus> {
    return this.enqueue(async () => {
      if (this.records.has(plugin.name)) {
        throw new Error(`plugin already mounted: ${plugin.name} (unmount it first, or use swap)`);
      }
      this.records.set(plugin.name, {
        plugin: plugin as AresPlugin<unknown>,
        config,
        state: "pending",
        cleanups: [],
        provides: new Set(),
        activatedAt: 0,
      });
      await this.settle();
      return this.statusOf(plugin.name)!;
    });
  }

  /** Unmount by name: dependents deactivate first, then the plugin's own
   *  effects unwind in reverse order. Unknown names resolve false. */
  unmount(name: string): Promise<boolean> {
    return this.enqueue(async () => {
      const record = this.records.get(name);
      if (!record) return false;
      await this.deactivateCascade(name);
      this.records.delete(name);
      await this.settle();
      return true;
    });
  }

  /** Hot reload: atomically replace a plugin (same or new name) — the old
   *  unwinds fully before the new mounts, inside one serialized operation. */
  swap<C>(plugin: AresPlugin<C>, config?: C): Promise<PluginStatus> {
    return this.enqueue(async () => {
      const existing = this.records.get(plugin.name);
      if (existing) {
        await this.deactivateCascade(plugin.name);
        this.records.delete(plugin.name);
      }
      this.records.set(plugin.name, {
        plugin: plugin as AresPlugin<unknown>,
        config,
        state: "pending",
        cleanups: [],
        provides: new Set(),
        activatedAt: 0,
      });
      await this.settle();
      return this.statusOf(plugin.name)!;
    });
  }

  /** Tear everything down, newest activation first. The host is unusable after. */
  dispose(): Promise<void> {
    return this.enqueue(async () => {
      const active = [...this.records.values()]
        .filter((r) => r.state === "active")
        .sort((a, b) => b.activatedAt - a.activatedAt);
      for (const record of active) await this.deactivate(record);
      this.records.clear();
      this.services.clear();
      this.listeners.clear();
      this.disposed = true;
    });
  }

  /** A service's current value (undefined when absent). */
  service<T>(name: string): T | undefined {
    return this.services.get(name)?.value as T | undefined;
  }

  statusOf(name: string): PluginStatus | undefined {
    const record = this.records.get(name);
    if (!record) return undefined;
    return {
      name,
      state: record.state,
      waitingOn: (record.plugin.inject ?? []).filter((dep) => !this.services.has(dep)),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  status(): PluginStatus[] {
    return [...this.records.keys()].map((name) => this.statusOf(name)!);
  }

  /** Host-side emit (same bus the plugins see). */
  emit(event: string, payload?: unknown): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      try {
        handler(payload);
      } catch {
        // A listener must never break the emitter or its sibling listeners.
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("plugin host is disposed"));
    const result = this.ops.then(op);
    this.ops = result.then(
      () => undefined,
      () => undefined, // one op's failure never wedges the chain
    );
    return result;
  }

  /** Activate every pending plugin whose dependencies exist, to fixpoint —
   *  one activation can provide the service the next was waiting on. Mount
   *  order breaks ties so the outcome is deterministic AND path-independent:
   *  the fixpoint itself depends only on the mounted set. */
  private async settle(): Promise<void> {
    for (;;) {
      let progressed = false;
      for (const [name, record] of this.records) {
        if (record.state !== "pending") continue;
        const missing = (record.plugin.inject ?? []).some((dep) => !this.services.has(dep));
        if (missing) continue;
        await this.activate(name, record);
        progressed = true;
      }
      if (!progressed) return;
    }
  }

  private async activate(name: string, record: PluginRecord): Promise<void> {
    const ctx: PluginContext = {
      pluginName: name,
      effect: (cleanup) => {
        record.cleanups.push(cleanup);
      },
      provide: (serviceName, service) => {
        const existing = this.services.get(serviceName);
        if (existing) {
          throw new Error(
            `service "${serviceName}" is already provided by ${existing.owner} — two live providers would make resolution order-dependent`,
          );
        }
        this.services.set(serviceName, { value: service, owner: name });
        record.provides.add(serviceName);
        record.cleanups.push(() => {
          this.services.delete(serviceName);
          record.provides.delete(serviceName);
        });
      },
      service: (serviceName) => this.services.get(serviceName)?.value as never,
      on: (event, handler) => {
        const bucket = this.listeners.get(event) ?? new Set();
        bucket.add(handler);
        this.listeners.set(event, bucket);
        record.cleanups.push(() => {
          bucket.delete(handler);
        });
      },
      emit: (event, payload) => this.emit(event, payload),
    };
    try {
      await record.plugin.setup(ctx, record.config);
      record.state = "active";
      record.activatedAt = ++this.activationClock;
      this.emit(HOST_EVENTS.activated, { name });
    } catch (error) {
      // Partial setup must leave no residue: unwind whatever it registered.
      await this.runCleanups(record);
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      this.emit(HOST_EVENTS.failed, { name, error: record.error });
    }
  }

  /** Deactivate `name` and, first, every ACTIVE plugin that transitively
   *  depends on a service it provides — newest activation first, so teardown
   *  is the exact reverse of the order things came up in. Dependents return
   *  to "pending": if the service reappears, they come back on their own. */
  private async deactivateCascade(name: string): Promise<void> {
    const root = this.records.get(name);
    if (!root || root.state !== "active") {
      if (root) root.state = root.state === "failed" ? "failed" : "pending";
      return;
    }
    const doomed = new Set<string>([name]);
    for (;;) {
      let grew = false;
      const doomedServices = new Set<string>();
      for (const doomedName of doomed) {
        for (const service of this.records.get(doomedName)?.provides ?? []) doomedServices.add(service);
      }
      for (const [candidate, record] of this.records) {
        if (doomed.has(candidate) || record.state !== "active") continue;
        if ((record.plugin.inject ?? []).some((dep) => doomedServices.has(dep))) {
          doomed.add(candidate);
          grew = true;
        }
      }
      if (!grew) break;
    }
    const ordered = [...doomed]
      .map((doomedName) => this.records.get(doomedName)!)
      .sort((a, b) => b.activatedAt - a.activatedAt);
    for (const record of ordered) await this.deactivate(record);
  }

  private async deactivate(record: PluginRecord): Promise<void> {
    if (record.state !== "active") return;
    await this.runCleanups(record);
    record.state = "pending";
    this.emit(HOST_EVENTS.deactivated, { name: record.plugin.name });
  }

  /** Reverse order holds ACROSS await points: each cleanup settles before the
   *  one registered beneath it starts, and one failure never strands the rest. */
  private async runCleanups(record: PluginRecord): Promise<void> {
    for (let i = record.cleanups.length - 1; i >= 0; i--) {
      try {
        await record.cleanups[i]();
      } catch {
        // One failing cleanup must not strand the ones beneath it.
      }
    }
    record.cleanups.length = 0;
    record.provides.clear();
  }
}

/** Identity helper so plugin modules get full typing without annotations. */
export function definePlugin<C = void>(plugin: AresPlugin<C>): AresPlugin<C> {
  return plugin;
}
