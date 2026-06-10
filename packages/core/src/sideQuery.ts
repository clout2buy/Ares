// sideQuery — the cheap one-shot judgment primitive.
//
// Fires ONE non-tool streaming call against a provider and concatenates
// the text. The Witness, session titling, and memory selection all share
// this shape. Economics: pass the SAME system prompt as the parent
// session and a cache-capable provider (Anthropic cache_control, OpenAI
// prompt_cache_key) serves the fork from its cached prefix — the
// per-call volatile parts (user text, schema hint) ride the user turn,
// so the prefix stays byte-stable.

import type { Message, ReasoningLevel } from "@ares/protocol";
import type { Provider } from "./queryEngine.js";

export interface SideQueryOptions {
  provider: Provider;
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal;
  /** Output ceiling for the reply. Default 1024 — judgments are short. */
  maxOutputTokens?: number;
  reasoningLevel?: ReasoningLevel;
}

export interface SideQueryJsonOptions extends SideQueryOptions {
  /** Shape description appended to the USER turn (never the system
   *  prompt — that would invalidate the shared cached prefix). */
  schemaHint: string;
}

/** Run one non-tool streaming call; return the concatenated text.
 *  Throws if the provider emits an error event. */
export async function sideQuery(opts: SideQueryOptions): Promise<string> {
  const messages: Message[] = [
    {
      id: `sq_${Date.now().toString(36)}`,
      role: "user",
      content: [{ type: "text", text: opts.user }],
      createdAt: new Date().toISOString(),
    },
  ];

  const parts: string[] = [];
  for await (const ev of opts.provider.stream({
    model: opts.model,
    system: opts.system,
    messages,
    tools: [],
    signal: opts.signal,
    reasoningLevel: opts.reasoningLevel,
    maxOutputTokens: opts.maxOutputTokens ?? 1024,
  })) {
    if (ev.type === "text_delta") {
      parts.push(ev.text);
    } else if (ev.type === "error") {
      throw new Error(`sideQuery(${opts.provider.name}): ${ev.error.message}`);
    }
  }
  return parts.join("");
}

/** sideQuery + parse: extract the first JSON object/array from the reply
 *  (tolerating code fences and surrounding prose). Throws with the raw
 *  reply text when nothing parseable comes back. */
export async function sideQueryJson<T = unknown>(opts: SideQueryJsonOptions): Promise<T> {
  const raw = await sideQuery({
    ...opts,
    user: `${opts.user}\n\nReply with ONLY JSON matching this shape: ${opts.schemaHint}`,
  });
  const extracted = extractFirstJson(raw);
  if (!extracted.ok) {
    throw new Error(`sideQueryJson: could not parse JSON from reply:\n${raw}`);
  }
  return extracted.value as T;
}

// ─── JSON extraction ────────────────────────────────────────────────────

function extractFirstJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  const text = unfence(raw);
  const start = firstBracket(text);
  if (start === -1) return { ok: false };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(text.slice(start, i + 1)) };
        } catch {
          return { ok: false };
        }
      }
    }
  }
  return { ok: false };
}

function unfence(raw: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return fence ? fence[1] : raw;
}

function firstBracket(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") return i;
  }
  return -1;
}
