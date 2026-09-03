// @ares/garrison — the Garrison: Ares's always-on daemon.
//
// Public surface:
//   - Wire protocol v1 types (the fixed client/server frame contract).
//   - ensureToken / constantTimeEqual — file-token auth.
//   - SessionManager + rehydrateSessions — N concurrent QueryEngine sessions
//     that outlive clients AND the daemon.
//   - Scheduler — heartbeat/dream ticks with injectable clocks.
//   - GarrisonServer — the localhost WebSocket+HTTP gateway.

export {
  PROTO_VERSION,
  DEFAULT_GARRISON_PORT,
  type GatewayClientFrame,
  type GatewayServerFrame,
  type SessionSummary,
  type GarrisonStatus,
} from "./protocol.js";

export { ensureToken, ensureReadToken, constantTimeEqual, garrisonDir, tokenPath, readTokenPath } from "./token.js";

export { viewerHtml } from "./viewer.js";

export {
  SessionManager,
  rehydrateSessions,
  rehydrateSession,
  sessionsDir,
  rolloutPath,
  SessionBusyError,
  UnknownSessionError,
  type SessionManagerOptions,
  type SessionFactory,
  type SessionFactoryRequest,
  type SessionFactoryResult,
  type SessionSubscriber,
  type SessionSendOptions,
  type SessionSendContext,
  type RehydratedSession,
  type SessionSurface,
  type SessionTenant,
  normalizeSessionSurface,
  normalizeSessionTenant,
} from "./sessions.js";

export {
  Scheduler,
  gauntletScheduleDefaults,
  type SchedulerOptions,
  type SchedulerHooks,
  type SchedulerHookName,
  type SchedulerEvent,
} from "./scheduler.js";

export {
  recordNightlyGauntlet,
  gauntletFindingId,
  type GauntletRunSummary,
  type NightlyGauntletOutcome,
  type RecordNightlyGauntletOptions,
} from "./gauntletNightly.js";

export {
  GarrisonServer,
  type GarrisonServerOptions,
  type ApprovalBridge,
  type ApprovalResponse,
} from "./server.js";

export { ApprovalQueue, type ApprovalQueueOptions } from "./approvals.js";
