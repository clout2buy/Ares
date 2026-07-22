// Ares Code — the embedded Vanguard engine host.
//
// One VanguardEngine lives inside the Ares daemon and serves the desktop's
// "Ares Code" tab. Vanguard sessions are entirely separate from Ares chat
// sessions: their events go out as `vanguard_event` frames keyed by
// `vanguardSessionId`, so the existing session fold never sees them.
//
// The engine is loaded lazily on the first vanguard_* command, so Ares boots
// and runs normally even when the Vanguard package is missing or broken; the
// tab then reports the load failure instead of the daemon dying.

type EmitFn = (obj: Record<string, unknown>) => void;

interface VanguardCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface EngineModule {
  VanguardEngine: new (options: { logger?: (line: string) => void }) => VanguardEngineLike;
  PROVIDER_CHOICES: readonly { id: string; label: string }[];
  catalogModels: (provider: string, auth: "oauth" | "api-key") => readonly { id: string; note?: string }[];
  defaultModel: (provider: string) => string;
  supportsOAuth: (provider: string) => boolean;
  oauthStatus: (provider: string) => Promise<{ connected: boolean; detail?: string }>;
  oauthLogin: (provider: string) => Promise<unknown>;
  credentialVariable: (provider: string) => string;
}

interface VanguardEngineLike {
  create(config: Record<string, unknown>): Promise<{ sessionId: string } & Record<string, unknown>>;
  advance(sessionId: string, message?: string): Record<string, unknown>;
  steer(sessionId: string, message: string): Record<string, unknown>;
  cancel(sessionId: string): Record<string, unknown>;
  status(sessionId: string): Record<string, unknown>;
  subscribe(handler: (envelope: { sessionId: string; event: Record<string, unknown> }) => void): () => void;
  shutdown(): Promise<void>;
}

export interface VanguardHost {
  /** True for any command this host owns. */
  owns(type: unknown): type is string;
  handle(command: VanguardCommand, emit: EmitFn): Promise<void>;
  shutdown(): Promise<void>;
}

export function createVanguardHost(): VanguardHost {
  let modulePromise: Promise<EngineModule> | undefined;
  let engine: VanguardEngineLike | undefined;
  let unsubscribe: (() => void) | undefined;
  // Display metadata the UI needs to re-render its session rail after reloads.
  const known = new Map<string, { workspace: string; provider: string; model: string; createdAt: number }>();

  const loadModule = (): Promise<EngineModule> => {
    modulePromise ??= import("vanguard") as unknown as Promise<EngineModule>;
    return modulePromise;
  };

  const ensureEngine = async (emit: EmitFn): Promise<VanguardEngineLike> => {
    const mod = await loadModule();
    if (engine === undefined) {
      engine = new mod.VanguardEngine({ logger: () => {} });
      unsubscribe = engine.subscribe(({ sessionId, event }) => {
        emit({ type: "vanguard_event", vanguardSessionId: sessionId, event });
      });
    }
    return engine;
  };

  const fail = (emit: EmitFn, command: VanguardCommand, error: unknown): void => {
    emit({
      type: "vanguard_error",
      command: command.type,
      ...(typeof command.vanguardSessionId === "string" ? { vanguardSessionId: command.vanguardSessionId } : {}),
      message: error instanceof Error ? error.message : String(error),
    });
  };

  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
    return value;
  };

  return {
    owns(type: unknown): type is string {
      return typeof type === "string" && type.startsWith("vanguard_");
    },

    async handle(command, emit): Promise<void> {
      try {
        switch (command.type) {
          case "vanguard_providers": {
            const mod = await loadModule();
            const providers = await Promise.all(mod.PROVIDER_CHOICES.map(async (choice) => {
              const oauth = mod.supportsOAuth(choice.id)
                ? await mod.oauthStatus(choice.id).catch(() => ({ connected: false }))
                : undefined;
              const auth: "oauth" | "api-key" = oauth?.connected === true ? "oauth" : "api-key";
              let models: readonly { id: string; note?: string }[] = [];
              try {
                models = mod.catalogModels(choice.id, auth);
              } catch {
                models = [];
              }
              return {
                id: choice.id,
                label: choice.label,
                defaultModel: models[0]?.id ?? mod.defaultModel(choice.id),
                credentialVariable: mod.credentialVariable(choice.id),
                keyPresent: (process.env[mod.credentialVariable(choice.id)] ?? "") !== "",
                oauth,
                models,
              };
            }));
            emit({ type: "vanguard_providers", providers });
            return;
          }
          case "vanguard_login": {
            const mod = await loadModule();
            const provider = text(command.provider, "provider");
            await mod.oauthLogin(provider);
            const oauth = await mod.oauthStatus(provider).catch(() => ({ connected: false }));
            emit({ type: "vanguard_login", provider, oauth });
            return;
          }
          case "vanguard_create": {
            const live = await ensureEngine(emit);
            const workspace = text(command.workspace, "workspace");
            const provider = text(command.provider, "provider");
            const model = text(command.model, "model");
            const config = {
              workspace,
              provider,
              model,
              auth: typeof command.auth === "string" ? command.auth : "api-key",
              // Ares Code edits the real tree like the Ares agent does; git is
              // the undo. Callers can still ask for an isolated session copy.
              ...(command.isolated === true ? {} : { direct: true }),
              maxSteps: typeof command.maxSteps === "number" ? command.maxSteps : 240,
            };
            let status;
            try {
              status = await live.create(config);
            } catch (error) {
              // A blank or unrecognized project has no detectable build/test
              // contract; fall back to Vanguard's adaptive trusted verifier,
              // which makes the agent establish one before completing.
              const message = error instanceof Error ? error.message : String(error);
              if (!/detect project verification/iu.test(message)) throw error;
              status = await live.create({ ...config, adaptiveVerification: true });
            }
            known.set(status.sessionId, { workspace, provider, model, createdAt: Date.now() });
            emit({ type: "vanguard_session", vanguardSessionId: status.sessionId, status, workspace, provider, model });
            return;
          }
          case "vanguard_advance": {
            const live = await ensureEngine(emit);
            const sessionId = text(command.vanguardSessionId, "vanguardSessionId");
            const status = live.advance(sessionId, typeof command.message === "string" ? command.message : undefined);
            emit({ type: "vanguard_status", vanguardSessionId: sessionId, status });
            return;
          }
          case "vanguard_steer": {
            const live = await ensureEngine(emit);
            const sessionId = text(command.vanguardSessionId, "vanguardSessionId");
            const message = text(command.message, "message");
            // One verb from the UI: a live run is steered, anything else is a
            // fresh advance. The engine refuses steering on idle sessions.
            const state = (live.status(sessionId) as { state?: string }).state;
            const status = state === "running" || state === "waiting_for_user"
              ? live.steer(sessionId, message)
              : live.advance(sessionId, message);
            emit({ type: "vanguard_status", vanguardSessionId: sessionId, status });
            return;
          }
          case "vanguard_cancel": {
            const live = await ensureEngine(emit);
            const sessionId = text(command.vanguardSessionId, "vanguardSessionId");
            const status = live.cancel(sessionId);
            emit({ type: "vanguard_status", vanguardSessionId: sessionId, status });
            return;
          }
          case "vanguard_status": {
            const live = await ensureEngine(emit);
            const sessionId = text(command.vanguardSessionId, "vanguardSessionId");
            emit({ type: "vanguard_status", vanguardSessionId: sessionId, status: live.status(sessionId) });
            return;
          }
          case "vanguard_sessions": {
            emit({
              type: "vanguard_sessions",
              sessions: [...known.entries()].map(([id, meta]) => ({ vanguardSessionId: id, ...meta })),
            });
            return;
          }
          default:
            emit({ type: "vanguard_error", command: command.type, message: `unknown vanguard command: ${command.type}` });
        }
      } catch (error) {
        fail(emit, command, error);
      }
    },

    async shutdown(): Promise<void> {
      unsubscribe?.();
      await engine?.shutdown().catch(() => undefined);
      engine = undefined;
    },
  };
}
