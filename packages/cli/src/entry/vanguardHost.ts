// Vanguard drive mode — a second engine behind the same Ares cockpit.
//
// When a session's Vanguard mode is on, its sends are driven by the embedded
// VanguardEngine instead of the legacy turn pipeline, using the SAME Ares
// session identity, workspace, and current model selection. Vanguard's
// sanitized public events are translated into the daemon's native event
// vocabulary (turn_start / text_delta / thinking_delta / tool_start /
// tool_end / turn_end) tagged with the Ares session id, so the existing
// transcript renders a Vanguard turn exactly like any other — it just says
// Vanguard on the tin.
//
// The engine loads lazily on first use, so Ares boots and runs normally when
// the vanguard package is missing; the failure surfaces as a turn error.

interface EngineModule {
  VanguardEngine: new (options: { logger?: (line: string) => void }) => VanguardEngineLike;
  supportsOAuth: (provider: string) => boolean;
  oauthStatus: (provider: string) => Promise<{ connected: boolean }>;
  credentialVariable: (provider: string) => string;
}

interface VanguardEngineLike {
  create(config: Record<string, unknown>): Promise<{ sessionId: string }>;
  advance(sessionId: string, message?: string): Record<string, unknown>;
  steer(sessionId: string, message: string): Record<string, unknown>;
  cancel(sessionId: string): Record<string, unknown>;
  status(sessionId: string): { state?: string };
  subscribe(handler: (envelope: { sessionId: string; event: Record<string, unknown> }) => void): () => void;
  shutdown(): Promise<void>;
}

/** The daemon's tagEmit: events tagged with the Ares session id. */
type TagEmit = (sessionId: string | undefined, obj: Record<string, unknown>) => void;

/** Providers the Vanguard engine can drive natively. */
const DRIVABLE = new Set(["anthropic", "openai", "deepseek", "kimi", "ollama"]);

/** Ares uiSettings key fields, by provider family. */
const SETTINGS_KEYS: Readonly<Record<string, string>> = {
  anthropic: "anthropicKey",
  deepseek: "deepSeekKey",
  ollama: "ollamaApiKey",
};

interface Binding {
  vanguardSessionId: string;
  family: string;
  model: string;
  /** Ares session tag for emitted events (undefined = primary/untagged). */
  tag: string | undefined;
  /** FIFO of live tool-card ids, per tool name, for start/end matching. */
  pendingTools: Map<string, string[]>;
  /** Bytes streamed since the last committed message — dedupes agent.message. */
  deltaBytes: number;
  turnActive: boolean;
  turnStartedAt: number;
}

export interface VanguardDrive {
  isTurnActive(key: string): boolean;
  runTurn(
    key: string,
    tag: string | undefined,
    goal: string,
    selection: { workspace: string; family: string; model: string; settingsKey?: string },
  ): Promise<void>;
  steerTurn(key: string, text: string): boolean;
  interrupt(key: string): boolean;
  shutdown(): Promise<void>;
}

export function createVanguardDrive(tagEmit: TagEmit): VanguardDrive {
  let modulePromise: Promise<EngineModule> | undefined;
  let engine: VanguardEngineLike | undefined;
  let unsubscribe: (() => void) | undefined;
  const bindings = new Map<string, Binding>();
  const byVanguardId = new Map<string, Binding>();
  let toolCardSequence = 0;

  const loadModule = (): Promise<EngineModule> => {
    modulePromise ??= import("vanguard") as unknown as Promise<EngineModule>;
    return modulePromise;
  };

  const translate = (binding: Binding, ev: Record<string, unknown>): void => {
    const type = typeof ev.type === "string" ? ev.type : "";
    const title = typeof ev.title === "string" ? ev.title : "";
    const detail = typeof ev.detail === "string" ? ev.detail : undefined;
    const message = typeof ev.message === "string" ? ev.message : "";
    const emit = (obj: Record<string, unknown>): void => tagEmit(binding.tag, obj);
    switch (type) {
      case "agent.delta":
        binding.deltaBytes += message.length;
        emit({ type: "text_delta", text: message });
        return;
      case "agent.thinking":
        emit({ type: "thinking_delta", text: message });
        return;
      case "agent.message":
        // Streamed replies already went out as deltas; only surface a message
        // that never streamed (non-streaming providers, control decisions).
        if (binding.deltaBytes === 0 && message) emit({ type: "text_delta", text: message });
        binding.deltaBytes = 0;
        return;
      case "tool.started": {
        const tool = typeof ev.tool === "string" ? ev.tool : "tool";
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        const queue = binding.pendingTools.get(tool) ?? [];
        queue.push(id);
        binding.pendingTools.set(tool, queue);
        emit({ type: "tool_start", id, name: tool, activityDescription: detail ?? title ?? tool });
        return;
      }
      case "tool.completed":
      case "tool.failed": {
        const tool = typeof ev.tool === "string" ? ev.tool : "tool";
        const id = binding.pendingTools.get(tool)?.shift();
        const durationMs = typeof ev.durationMs === "number" ? ev.durationMs : undefined;
        if (id === undefined) return;
        if (type === "tool.completed") emit({ type: "tool_end", id, display: detail ?? "done", durationMs });
        else emit({ type: "tool_error", id, error: detail ?? "failed", durationMs });
        return;
      }
      case "run.contracted": {
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        emit({ type: "tool_start", id, name: "vanguard.contract", activityDescription: "task contracted" });
        emit({ type: "tool_end", id, display: detail ?? title ?? "objective and success criteria locked" });
        return;
      }
      case "completion.claimed": {
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        emit({ type: "tool_start", id, name: "vanguard.verify", activityDescription: "completion claimed — verifying" });
        binding.pendingTools.set("vanguard.verify", [...(binding.pendingTools.get("vanguard.verify") ?? []), id]);
        return;
      }
      case "verification.completed": {
        const pending = binding.pendingTools.get("vanguard.verify")?.shift();
        const passed = ev.status === "passed";
        if (pending !== undefined) {
          if (passed) tagEmit(binding.tag, { type: "tool_end", id: pending, display: detail ?? "verifiers accepted the completion" });
          else tagEmit(binding.tag, { type: "tool_error", id: pending, error: detail ?? "verifiers rejected the completion" });
          return;
        }
        toolCardSequence += 1;
        const id = `vanguard-${toolCardSequence}`;
        emit({ type: "tool_start", id, name: "vanguard.verify", activityDescription: title || "independent verification" });
        if (passed) emit({ type: "tool_end", id, display: detail ?? "passed" });
        else emit({ type: "tool_error", id, error: detail ?? "failed" });
        return;
      }
      case "run.waiting_for_user":
        if (message && binding.deltaBytes === 0) emit({ type: "text_delta", text: message });
        binding.deltaBytes = 0;
        return;
      default:
        return; // lifecycle/usage frames feed the turn loop, not the transcript
    }
  };

  const ensureEngine = async (): Promise<VanguardEngineLike> => {
    const mod = await loadModule();
    if (engine === undefined) {
      engine = new mod.VanguardEngine({ logger: () => {} });
      unsubscribe = engine.subscribe(({ sessionId, event }) => {
        const binding = byVanguardId.get(sessionId);
        if (binding !== undefined) translate(binding, event);
      });
    }
    return engine;
  };

  const resolveAuth = async (family: string, settingsKey: string | undefined): Promise<"oauth" | "api-key"> => {
    const mod = await loadModule();
    if (mod.supportsOAuth(family)) {
      const status = await mod.oauthStatus(family).catch(() => ({ connected: false }));
      if (status.connected) return "oauth";
    }
    const variable = mod.credentialVariable(family);
    if ((process.env[variable] ?? "") !== "") return "api-key";
    // Fall back to the key the owner gave Ares itself, so Vanguard mode needs
    // zero extra setup. Injected into this process's env only.
    if (settingsKey !== undefined && settingsKey !== "") {
      process.env[variable] = settingsKey;
      return "api-key";
    }
    if (family === "ollama") return "api-key"; // local daemon needs no key
    throw new Error(
      `Vanguard has no ${family} credential: sign in with \`vanguard login ${family}\` or set ${variable}.`,
    );
  };

  const ensureBinding = async (
    key: string,
    tag: string | undefined,
    selection: { workspace: string; family: string; model: string; settingsKey?: string },
  ): Promise<Binding> => {
    const existing = bindings.get(key);
    if (existing !== undefined && existing.family === selection.family && existing.model === selection.model) {
      return existing;
    }
    if (!DRIVABLE.has(selection.family)) {
      throw new Error(
        `Vanguard drives anthropic, openai, deepseek, kimi, and ollama — the current selection is ${selection.family}. Switch model or turn Vanguard mode off.`,
      );
    }
    const live = await ensureEngine();
    const auth = await resolveAuth(selection.family, selection.settingsKey);
    const config = {
      workspace: selection.workspace,
      provider: selection.family,
      model: selection.model,
      auth,
      direct: true, // same trust model as the Ares agent: real tree, git undo
      maxSteps: 240,
    };
    let created;
    try {
      created = await live.create(config);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/detect project verification/iu.test(text)) throw error;
      created = await live.create({ ...config, adaptiveVerification: true });
    }
    if (existing !== undefined) byVanguardId.delete(existing.vanguardSessionId);
    const binding: Binding = {
      vanguardSessionId: created.sessionId,
      family: selection.family,
      model: selection.model,
      tag,
      pendingTools: new Map(),
      deltaBytes: 0,
      turnActive: false,
      turnStartedAt: 0,
    };
    bindings.set(key, binding);
    byVanguardId.set(created.sessionId, binding);
    return binding;
  };

  return {
    isTurnActive(key: string): boolean {
      return bindings.get(key)?.turnActive === true;
    },

    async runTurn(key, tag, goal, selection): Promise<void> {
      const startedAt = Date.now();
      tagEmit(tag, { type: "turn_start" });
      let binding: Binding | undefined;
      try {
        binding = await ensureBinding(key, tag, selection);
        binding.tag = tag;
        binding.turnActive = true;
        binding.turnStartedAt = startedAt;
        binding.deltaBytes = 0;
        const live = await ensureEngine();
        live.advance(binding.vanguardSessionId, goal);
        // The worker runs in the background; the turn settles when the session
        // leaves "running". Public events stream to the transcript meanwhile.
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          const state = live.status(binding.vanguardSessionId).state;
          if (state !== "running") {
            tagEmit(tag, {
              type: "turn_end",
              status: state === "failed" ? "failed" : "ok",
              usage: {},
              durationMs: Date.now() - startedAt,
            });
            return;
          }
        }
      } catch (error) {
        tagEmit(tag, { type: "text_delta", text: `Vanguard engine: ${error instanceof Error ? error.message : String(error)}` });
        tagEmit(tag, { type: "turn_end", status: "failed", usage: {}, durationMs: Date.now() - startedAt });
      } finally {
        if (binding !== undefined) binding.turnActive = false;
      }
    },

    steerTurn(key: string, text: string): boolean {
      const binding = bindings.get(key);
      if (binding === undefined || !binding.turnActive || engine === undefined) return false;
      try {
        engine.steer(binding.vanguardSessionId, text);
        return true;
      } catch {
        return false;
      }
    },

    interrupt(key: string): boolean {
      const binding = bindings.get(key);
      if (binding === undefined || !binding.turnActive || engine === undefined) return false;
      try {
        engine.cancel(binding.vanguardSessionId);
        return true;
      } catch {
        return false;
      }
    },

    async shutdown(): Promise<void> {
      unsubscribe?.();
      await engine?.shutdown().catch(() => undefined);
      engine = undefined;
    },
  };
}
