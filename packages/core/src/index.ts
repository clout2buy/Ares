// @ares/core — runtime kernel for Ares v2.
//
// Public surface:
//   - QueryEngine: the streaming agent loop.
//   - Provider interface + reference implementations.
//
// Everything is event-driven; no direct stdout/stderr writes from this package.

export {
  QueryEngine,
  budgetMessages,
  buildContextLedger,
  collectTrimmedFilePaths,
  chooseCompactionSplit,
  stringifyModelToolOutput,
  type QueryEngineConfig,
  type Provider,
  type ProviderRequest,
  type ProviderToolDescriptor,
  type EngineTool,
  type EngineToolResult,
  type ToolCallContext,
  type ToolPermissionRequest,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  isToolUseBlock,
} from "./queryEngine.js";

export {
  runForkedTurn,
  type ForkedTurnOptions,
  type ForkedTurnResult,
  type ForkedTurnSeed,
} from "./forkedTurn.js";

export { MockEchoProvider } from "./providers/mock.js";
export { parseRetryAfterMs } from "./providers/retryAfter.js";

export {
  AnthropicProvider,
  ANTHROPIC_MESSAGES_URL,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";

export {
  startAnthropicLogin,
  finishAnthropicLogin,
  runAnthropicLoginFlow,
  loadAnthropicTokens,
  clearAnthropicTokens,
  resolveAnthropicAccessToken,
  type AnthropicOAuthTokens,
  type AnthropicAuthChallenge,
} from "./providers/anthropicAuth.js";

export {
  sideQuery,
  sideQueryJson,
  extractFirstJson,
  type SideQueryOptions,
  type SideQueryJsonOptions,
} from "./sideQuery.js";

export {
  runFleet,
  resolveTemplates,
  validateSpec,
  MAX_AGENTS_PER_PHASE,
  MAX_AGENTS_PER_FLEET,
  MAX_CONCURRENCY,
  FORBIDDEN_CHILD_TOOLS,
  type FleetSpec,
  type FleetPhaseSpec,
  type FleetAgentSpec,
  type FleetReduce,
  type FleetResult,
  type PhaseResult,
  type LeafResult,
  type ConductorDeps,
  type LeafValidator,
  type SchemaHinter,
  type ValidatorResult,
  type RunAgentFn,
  type RunAgentArgs,
  type RunAgentResult,
  type Worktree,
} from "./conductor.js";

export {
  SubagentRegistry,
  AresSubagentRunner,
  BUILT_IN_SUBAGENT_TYPES,
  type SubagentRunner,
  type SubagentRunnerOptions,
  type SubagentTypeDef,
  type SubagentRunRequest,
  type SubagentRunResult,
} from "./subagents.js";

export {
  ContinuousVerifier,
  deriveNarrowVerify,
  findRelatedTestFiles,
  type VerifierOptions,
  type VerifyCommand,
  type VerifyResult,
  type VerifyEvent,
  type WorkspaceSetup,
} from "./verifier.js";

export {
  HookManager,
  type HookConfigEntry,
  type HookEvent,
  type HookRunInput,
  type HookRunResult,
} from "./hooks.js";

export {
  Session,
  listSessions,
  loadSessionSnapshot,
  deleteSession,
  renameSession,
  type SessionOptions,
  type SessionSummary,
  type SessionSnapshot,
  type LoadSessionSnapshotOptions,
} from "./session.js";

export {
  createWorkspaceCheckpoint,
  listWorkspaceCheckpoints,
  loadWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  diffWorkspaceCheckpointUnified,
  restoreWorkspaceCheckpoint,
  type CreateCheckpointOptions,
} from "./checkpoints.js";

export {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
} from "./providers/openaiResponses.js";

export {
  loadAuthToken,
  authStatus,
  authFilePath,
  aresHome,
  deviceCodeLogin,
  type AuthToken,
  type AuthStatus,
  type AuthMode,
  type AuthSource,
  type DeviceCodeChallenge,
  type DeviceCodeLoginOptions,
} from "./providers/openaiAuth.js";

export {
  OllamaCloudPool,
  DEFAULT_OLLAMA_SLOTS,
  OLLAMA_CLOUD_MODELS,
  ollamaCloudModelsFor,
  type SlotName,
  type SlotConfig,
  type OllamaCloudPoolOptions,
  type OllamaCloudModel,
} from "./providers/ollamaCloud.js";

export {
  DeepSeekProvider,
  OpenRouterProvider,
  fetchDeepSeekModels,
  fetchOpenRouterModels,
  DEEPSEEK_BASE_URL,
  OPENROUTER_BASE_URL,
  type DeepSeekProviderOptions,
  type DeepSeekModel,
  type OpenRouterProviderOptions,
  type OpenRouterModel,
} from "./providers/openrouter.js";

export { buildPromptCacheKey, type PromptCacheKey } from "./promptCache.js";

export {
  getCredential,
  setCredential,
  deleteCredential,
  listCredentialNames,
  hasCredential,
  encryptSecret,
  decryptSecret,
  type CredentialLookup,
} from "./credentials.js";

export {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
  getValidAccessToken,
  storeTokens,
  loadTokens,
  isExpired,
  clientIdName,
  clientSecretName,
  type OAuthProviderConfig,
  type OAuthTokens,
  type OAuthDeps,
} from "./oauth.js";

export {
  OAUTH_PROVIDERS,
  PROVIDER_LABELS,
  getProviderConfig,
  listProviders,
} from "./oauthProviders.js";

export {
  startOAuthFlow,
  connectedProviders,
  type OAuthFlowOptions,
} from "./oauthCallback.js";

export {
  routeModel,
  resolveRoute,
  laneForTask,
  classifyLane,
  taskDefaults,
  ROUTE_LANES,
  DEFAULT_PROVIDER_PROFILES,
  type RouteLane,
  type RouteAssignment,
  type RouteAssignments,
  type ResolvedRoute,
  type ModelTask,
  type ModelTaskKind,
  type ModelRoute,
  type ModelRouteDecision,
  type ModelRoutingPolicy,
  type ModelProviderProfile,
  type ModelCapability,
  type RiskLevel,
  type PrivacyPosture,
  type QualityNeed,
  type CostPreference,
  type LatencyPreference,
  type Locality,
  type ModelTouch,
} from "./modelRouter.js";

export {
  loadStartupReminders,
  loadMemoryReminders,
  loadInstructionReminders,
  type StartupReminder,
  type StartupReminderSource,
} from "./startupContext.js";

export {
  crashDir,
  writeCrashLogSync,
  installGlobalCrashHandlers,
  EventRing,
  type CrashKind,
  type CrashRecord,
  type CrashHandlerOptions,
} from "./crashLog.js";

export {
  parsePatch,
  parsePatchText,
  PatchParseError,
  type Hunk,
  type UpdateFileChunk,
  type ApplyPatchArgs,
  type ParseMode,
  BEGIN_PATCH_MARKER,
  END_PATCH_MARKER,
  ADD_FILE_MARKER,
  DELETE_FILE_MARKER,
  UPDATE_FILE_MARKER,
  MOVE_TO_MARKER,
  EOF_MARKER,
  CHANGE_CONTEXT_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
} from "./applyPatch/parser.js";
