// MockEchoProvider — deterministic provider for tests and the M0 smoke test.
//
// Behavior:
//   - Reads the last user message text.
//   - Streams it back in 8-char chunks as text_delta events.
//   - Yields one message_done with stopReason "end_turn".
//
// Never produces tool_use blocks (so QueryEngine exits after one iteration).

import { appendFileSync } from "node:fs";
import type { Message, StreamEvent } from "@ares/protocol";
import { messageText } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";

export class MockEchoProvider implements Provider {
  readonly name = "mock-echo";

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    // Test seam: ARES_MOCK_REQUEST_LOG=<file> appends every request (system
    // prompt + messages, reminders included) as one JSON line, so daemon tests
    // can assert what actually reached the wire.
    const requestLog = process.env.ARES_MOCK_REQUEST_LOG;
    if (requestLog) {
      try {
        appendFileSync(requestLog, JSON.stringify({ model: req.model, system: req.system, messages: req.messages.map((m) => ({ role: m.role, content: m.content })) }) + "\n", "utf8");
      } catch {
        // a test seam must never break a turn
      }
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const inputText = lastUser ? messageText(lastUser) : "";
    if (inputText.includes("__mock_fail_provider__")) {
      throw new Error("injected mock provider failure");
    }
    if (inputText.includes("__mock_extra_usage__")) {
      // Anthropic's subscription-exhaustion shape: a 400, not a 402/429.
      yield {
        type: "error",
        error: {
          code: "http_400",
          message: 'Anthropic returned 400: {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
          retriable: false,
        },
      };
      return;
    }
    // Stays empty through the engine's nudge too (any turn of a conversation
    // that carries the trigger).
    if (req.messages.some((m) => m.role === "user" && messageText(m).includes("__mock_empty_reply__"))) {
      // A model that ends its turn having said and done nothing (end_turn, 0 output).
      yield {
        type: "message_done",
        message: { id: `mock_empty_${Date.now()}`, role: "assistant", content: [], createdAt: new Date().toISOString() },
        usage: { inputTokens: 10, outputTokens: 0 },
        stopReason: "end_turn",
      };
      return;
    }
    if (inputText.includes("__mock_bad_request__")) {
      // A 400 the failover ladder does not treat as a provider death.
      yield {
        type: "error",
        error: {
          code: "http_400",
          message: 'Anthropic returned 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: unexpected block"}}',
          retriable: false,
        },
      };
      return;
    }
    if (inputText.includes("__mock_wedge__")) {
      // A provider that ignores abort entirely: the turn can only end by the
      // daemon abandoning it (force-Stop zombie release).
      await new Promise<void>(() => {});
      return;
    }
    if (inputText.includes("__mock_stall__")) {
      await new Promise<void>((_, reject) => {
        req.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      return;
    }
    if (inputText.includes("__mock_request_stats__")) {
      const totalChars = req.messages.reduce((sum, message) => sum + messageText(message).length, 0);
      const replyText = [
        `messages=${req.messages.length}`,
        `chars=${totalChars}`,
        `reasoning=${req.reasoningLevel ?? "unset"}`,
        `maxOutput=${req.maxOutputTokens ?? "unset"}`,
      ].join(" ");
      yield { type: "text_delta", text: replyText };
      yield {
        type: "message_done",
        message: {
          id: `msg_${Date.now().toString(36)}`,
          role: "assistant",
          content: [{ type: "text", text: replyText }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: totalChars, outputTokens: replyText.length },
        stopReason: "end_turn",
      };
      return;
    }
    if (inputText.includes("__mock_read_tool__")) {
      const filePath = mockReadToolPath(inputText);
      const toolInput = { file_path: filePath, limit: 1 };
      const toolId = "mock_read_1";
      yield { type: "tool_use_start", id: toolId, name: "Read" };
      yield { type: "tool_use_input_done", id: toolId, input: toolInput };
      yield {
        type: "message_done",
        message: {
          id: `msg_${Date.now().toString(36)}`,
          role: "assistant",
          content: [{ type: "tool_use", id: toolId, name: "Read", input: toolInput }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: inputText.length, outputTokens: 0 },
        stopReason: "tool_use",
      };
      return;
    }
    const replyText = `echo: ${inputText}`;

    const steeringWindow = inputText.includes("__mock_steer_window__");
    let chunkIndex = 0;
    for (const chunk of chunkString(replyText, 8)) {
      yield { type: "text_delta", text: chunk };
      // Deterministic daemon integration seam: let stdin deliver a correction
      // after the first visible delta without generating thousands of chunks or
      // depending on host CPU scheduling.
      if (steeringWindow && chunkIndex++ === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }

    const message: Message = {
      id: `msg_${Date.now().toString(36)}`,
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      createdAt: new Date().toISOString(),
    };

    yield {
      type: "message_done",
      message,
      usage: { inputTokens: inputText.length, outputTokens: replyText.length },
      stopReason: "end_turn",
    };
  }
}

function mockReadToolPath(inputText: string): string {
  const [, rawPath] = inputText.split("__mock_read_tool__", 2);
  return rawPath?.trim().split(/\s+/, 1)[0] || "package.json";
}

function chunkString(s: string, size: number): string[] {
  if (s.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
