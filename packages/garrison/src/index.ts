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
  type SessionAttachment,
  type GarrisonStatus,
} from "./protocol.js";

export { ensureToken, ensureReadToken, constantTimeEqual, garrisonDir, tokenPath, readTokenPath } from "./token.js";

export { viewerHtml } from "./viewer.js";

export {
  DeviceBridge,
  DEVICE_DEFAULT_TIMEOUT_MS,
  DEVICE_MAX_TIMEOUT_MS,
  DEVICE_MAX_RESULT_BYTES,
  summarizeDeviceArgs,
  type DeviceBridgeOptions,
  type DeviceWake,
  type DeviceWakeInfo,
  type DevicePendingRequest,
} from "./deviceBridge.js";

export {
  SessionManager,
  rehydrateSessions,
  rehydrateSession,
  loadGarrisonRollout,
  compactRolloutEvent,
  ROLLOUT_PROGRESS_TEXT_CAP,
  sessionsDir,
  rolloutPath,
  SessionBusyError,
  InputConflictError,
  UnknownSessionError,
  type SessionManagerOptions,
  type SessionFactory,
  type SessionFactoryRequest,
  type SessionFactoryResult,
  type SessionSubscriber,
  type SessionSendOptions,
  type SessionSendContext,
  type SessionPersonaHooks,
  type RehydratedSession,
  type RunningTurn,
  type PendingPermissionInfo,
  type PermissionOutcome,
  type SessionSurface,
  type SessionTenant,
  normalizeSessionSurface,
  normalizeSessionTenant,
  normalizeSessionAttachments,
  MAX_ATTACHMENT_BASE64_CHARS,
  inputContent,
  MAX_ATTACHMENTS_PER_INPUT,
} from "./sessions.js";

export {
  Scheduler,
  gauntletScheduleDefaults,
  type SchedulerOptions,
  type SchedulerHooks,
  type SchedulerHookName,
  type SchedulerEvent,
  type SchedulerJobStatus,
} from "./scheduler.js";

export { canonicalActionKey, repeatDenialError } from "./ownerGuards.js";

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

export { ApprovalQueue, type ApprovalQueueOptions, type ApprovalOutcome } from "./approvals.js";
