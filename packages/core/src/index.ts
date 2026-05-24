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
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  isToolUseBlock,
} from "./queryEngine.js";

export { MockEchoProvider } from "./providers/mock.js";
