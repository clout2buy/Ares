// @crix/core — runtime kernel for Crix v2.
//
// Public surface:
//   - QueryEngine: the streaming agent loop.
//   - Provider interface + reference implementations.
//
// Everything is event-driven; no direct stdout/stderr writes from this package.

export {
  QueryEngine,
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

export { MockEchoProvider } from "./providers/mock.js";

export {
  Session,
  listSessions,
  loadSessionSnapshot,
  type SessionOptions,
  type SessionSummary,
  type SessionSnapshot,
  type LoadSessionSnapshotOptions,
} from "./session.js";

export {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
} from "./providers/openaiResponses.js";

export {
  loadAuthToken,
  authStatus,
  authFilePath,
  crixHome,
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
  type SlotName,
  type SlotConfig,
  type OllamaCloudPoolOptions,
} from "./providers/ollamaCloud.js";

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
