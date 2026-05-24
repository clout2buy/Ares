// MockEchoProvider — deterministic provider for tests and the M0 smoke test.
//
// Behavior:
//   - Reads the last user message text.
//   - Streams it back in 8-char chunks as text_delta events.
//   - Yields one message_done with stopReason "end_turn".
//
// Never produces tool_use blocks (so QueryEngine exits after one iteration).

import type { Message, StreamEvent } from "@crix/protocol";
import { messageText } from "@crix/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";

export class MockEchoProvider implements Provider {
  readonly name = "mock-echo";

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const inputText = lastUser ? messageText(lastUser) : "";
    const replyText = `echo: ${inputText}`;

    for (const chunk of chunkString(replyText, 8)) {
      yield { type: "text_delta", text: chunk };
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

function chunkString(s: string, size: number): string[] {
  if (s.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
