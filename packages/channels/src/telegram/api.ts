// Thin Telegram Bot API client over raw fetch — no SDK. Four methods, clean
// error surfaces (TelegramApiError, never the token), AbortSignal passthrough,
// and 429 handling that honors parameters.retry_after with an injectable
// sleep so tests never wait. The fetch surface is duck-typed (status + json)
// so fakes stay one object literal.

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  date?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageOptions {
  replyMarkup?: InlineKeyboardMarkup;
  parseMode?: "MarkdownV2" | "HTML";
  signal?: AbortSignal;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface TelegramApiOptions {
  fetchImpl?: FetchLike;
  /** Default https://api.telegram.org */
  baseUrl?: string;
  /** Injectable for tests; default real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** How many 429s to absorb per call before surfacing. Default 3. */
  max429Retries?: number;
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly code: number;
  readonly description: string;

  constructor(method: string, code: number, description: string) {
    super(`telegram ${method} failed (${code}): ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.code = code;
    this.description = description;
  }
}

interface TgEnvelope<T> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramApi {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly max429: number;

  constructor(token: string, opts: TelegramApiOptions = {}) {
    this.token = token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.base = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.max429 = opts.max429Retries ?? 3;
  }

  /** Long-poll for updates. `timeoutS` is Telegram's server-side hold, in seconds. */
  async getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    const result = await this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] },
      signal,
    );
    return Array.isArray(result) ? result : [];
  }

  async sendMessage(chatId: number, text: string, opts: SendMessageOptions = {}): Promise<TgMessage> {
    const params: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.replyMarkup) params.reply_markup = opts.replyMarkup;
    if (opts.parseMode) params.parse_mode = opts.parseMode;
    return this.call<TgMessage>("sendMessage", params, opts.signal);
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { replyMarkup?: InlineKeyboardMarkup; signal?: AbortSignal } = {},
  ): Promise<void> {
    const params: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
    if (opts.replyMarkup) params.reply_markup = opts.replyMarkup;
    await this.call<unknown>("editMessageText", params, opts.signal);
  }

  async answerCallbackQuery(callbackQueryId: string, opts: { text?: string; signal?: AbortSignal } = {}): Promise<void> {
    const params: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (opts.text) params.text = opts.text;
    await this.call<unknown>("answerCallbackQuery", params, opts.signal);
  }

  private async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: FetchResponseLike;
      try {
        res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal,
        });
      } catch (err) {
        // Aborts surface verbatim so callers can distinguish shutdown from failure.
        if (signal?.aborted) throw err;
        throw new TelegramApiError(method, 0, `network failure: ${errText(err)}`);
      }

      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        throw new TelegramApiError(method, res.status, "malformed (non-JSON) response body");
      }
      if (typeof raw !== "object" || raw === null) {
        throw new TelegramApiError(method, res.status, "malformed response body");
      }
      const body = raw as TgEnvelope<T>;
      if (body.ok === true) return body.result as T;

      const retryAfterS = body.parameters?.retry_after;
      const rateLimited = res.status === 429 || body.error_code === 429;
      if (rateLimited && typeof retryAfterS === "number" && attempt < this.max429) {
        await this.sleep(Math.max(0, retryAfterS) * 1000);
        continue;
      }
      throw new TelegramApiError(method, body.error_code ?? res.status, body.description ?? "unknown error");
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
