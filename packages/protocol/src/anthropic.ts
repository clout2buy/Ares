// Anthropic SDK alias layer.
//
// Ares's wire format is structurally identical to @anthropic-ai/sdk's
// message shape. This file re-exports Ares protocol types under the
// names the Anthropic SDK uses, so:
//
//   import type { MessageParam, ContentBlockParam } from "@ares/protocol/anthropic";
//
// gives you the same types you'd import from `@anthropic-ai/sdk`. When
// we add a direct-Anthropic provider later, the wire layer is a
// passthrough — no translation needed.
//
// The aliases are TYPE-ONLY: zero runtime, zero deps on the SDK itself.
// Drop @anthropic-ai/sdk into a project and these flow straight through.

import type {
  Message,
  Role,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  ThinkingBlock,
  ContentBlock,
  Usage,
  StopReason,
  ToolSchema,
} from "./types.js";

// ─── Anthropic SDK names → Ares types ──────────────────────────────────

/** Anthropic SDK: `MessageParam` (input to messages.create). */
export type MessageParam = {
  role: Exclude<Role, "system">;
  content: string | ContentBlockParam[];
};

/** Anthropic SDK: `ContentBlockParam` union for input messages. */
export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ThinkingBlockParam;

export type TextBlockParam = TextBlock;
export type ImageBlockParam = ImageBlock;
export type ToolUseBlockParam = ToolUseBlock;
export type ToolResultBlockParam = ToolResultBlock;
export type ThinkingBlockParam = ThinkingBlock;

/** Anthropic SDK: `Tool` (for the tools[] array in messages.create). */
export interface Tool {
  name: string;
  description: string;
  input_schema: object;
}

/** Anthropic SDK: `Message` (response from messages.create). */
export type AnthropicMessage = Message;

/** Anthropic SDK: `Usage`. */
export type AnthropicUsage = Usage;

/** Anthropic SDK: `StopReason`. */
export type AnthropicStopReason = StopReason;

/** Re-export the Ares content block union under the Anthropic name. */
export type { ContentBlock } from "./types.js";

/** Convenience: build a Tool schema entry from a ToolSchema. */
export function toAnthropicTool(schema: ToolSchema): Tool {
  return {
    name: schema.name,
    description: schema.description,
    input_schema: schema.inputJsonSchema,
  };
}
