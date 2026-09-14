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

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  /** Caption on a photo/document/video message (the user's text about it). */
  caption?: string;
  voice?: TgVoice;
  audio?: TgAudio;
  /** Photo sizes, smallest first — send the LAST one for full resolution. */
  photo?: TgPhotoSize[];
  document?: TgDocument;
  /** Album id: photos sent together share it, and arrive as separate updates. */
  media_group_id?: string;
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

export interface SendMediaOptions {
  caption?: string;
  /** Filename shown in the chat (documents) — defaults to "file". */
  filename?: string;
  /** MIME type for the multipart part; sniffed from the filename when absent. */
  contentType?: string;
  parseMode?: "HTML";
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

  /** Verify the bot token and identify the bot (setup: "is this token real?"). */
  async getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call<TgUser>("getMe", {}, signal);
  }

  /** Long-poll for updates. `timeoutS` is Telegram's server-side hold, in seconds. */
  async getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    const result = await this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] },
      signal,
      // Long-poll: the client deadline must outlast Telegram's server-side hold,
      // or we'd abort every healthy poll. Give it the server timeout + 20s slack.
      (timeoutS + 20) * 1000,
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

  /** Get file metadata (including file_path for download). */
  async getFile(fileId: string, signal?: AbortSignal): Promise<TgFile> {
    return this.call<TgFile>("getFile", { file_id: fileId }, signal);
  }

  /** Download a file by its file_path (from getFile). Returns raw bytes. */
  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    const url = `${this.base}/file/bot${this.token}/${filePath}`;
    // 60s client deadline so a stalled download (large voice note on a flaky
    // link) can't pin the channel indefinitely.
    const res = await fetch(url, { signal: this.deadline(signal, 60_000) });
    if (!res.ok) throw new TelegramApiError("downloadFile", res.status, `download failed: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Show the "typing…" bubble so the chat doesn't feel dead while Ares thinks.
   *  Telegram clears it after ~5s, so callers refresh it until the reply lands. */
  async sendChatAction(chatId: number, action: "typing" = "typing", signal?: AbortSignal): Promise<void> {
    await this.call<unknown>("sendChatAction", { chat_id: chatId, action }, signal);
  }

  /** Send a voice note (OGG/Opus buffer). Uses multipart/form-data since Telegram
   *  requires file uploads for voice messages. */
  async sendVoice(chatId: number, voice: Buffer, opts: { caption?: string; signal?: AbortSignal } = {}): Promise<TgMessage> {
    return this.upload("sendVoice", chatId, "voice", voice, { ...opts, filename: "voice.ogg", contentType: "audio/ogg" });
  }

  /** Send a photo (PNG/JPEG/WebP/GIF bytes). Telegram re-encodes photos, caps
   *  them at 10MB, and shows them inline — the "show me" primitive. */
  async sendPhoto(chatId: number, image: Buffer, opts: SendMediaOptions = {}): Promise<TgMessage> {
    return this.upload("sendPhoto", chatId, "photo", image, { filename: "photo.png", contentType: "image/png", ...opts });
  }

  /** Send any file as a document (up to 50MB). Filenames survive intact, so a
   *  report, log, PDF, or an oversized reply lands on the phone as a real file. */
  async sendDocument(chatId: number, file: Buffer, opts: SendMediaOptions = {}): Promise<TgMessage> {
    return this.upload("sendDocument", chatId, "document", file, { filename: "file", ...opts });
  }

  /** One multipart uploader for every media method; the field name is the only
   *  thing Telegram varies (voice / photo / document). */
  private async upload(
    method: "sendVoice" | "sendPhoto" | "sendDocument",
    chatId: number,
    field: "voice" | "photo" | "document",
    bytes: Buffer,
    opts: SendMediaOptions,
  ): Promise<TgMessage> {
    const filename = opts.filename ?? "file";
    const contentType = opts.contentType ?? mediaTypeForName(filename);
    const boundary = `----AresMedia${Date.now()}${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    const CRLF = "\r\n";
    const addField = (name: string, value: string) => {
      parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
    };
    addField("chat_id", String(chatId));
    if (opts.caption) addField("caption", opts.caption.slice(0, 1024));
    if (opts.parseMode) addField("parse_mode", opts.parseMode);
    const safeName = filename.replace(/["\r\n]/g, "_");
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${field}"; filename="${safeName}"${CRLF}Content-Type: ${contentType}${CRLF}${CRLF}`,
    ));
    parts.push(bytes);
    parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
    const body = Buffer.concat(parts);
    const res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: body as unknown as string,
      // Uploads of a few MB on a phone-grade uplink can take a while; 120s.
      signal: this.deadline(opts.signal, 120_000),
    });
    const raw = await res.json() as TgEnvelope<TgMessage>;
    if (!raw.ok) throw new TelegramApiError(method, raw.error_code ?? res.status, raw.description ?? "unknown");
    return raw.result as TgMessage;
  }

  /** Compose the caller's abort signal with a client-side timeout so a hung
   *  request can never block the channel forever (only a connection-level signal
   *  existed before). The timeout fires independently of the caller's signal, so
   *  shutdown vs. timeout stays distinguishable. */
  private deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 45_000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: FetchResponseLike;
      try {
        res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: this.deadline(signal, timeoutMs),
        });
      } catch (err) {
        // Caller aborts surface verbatim so callers can distinguish shutdown from
        // failure; a client-timeout (caller signal NOT aborted) becomes a normal
        // network failure the retry/backoff path can handle.
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

/** MIME type from a filename extension; the multipart part needs one. */
export function mediaTypeForName(name: string): string {
  const ext = name.toLowerCase().replace(/^.*\./, "");
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "pdf": return "application/pdf";
    case "txt": case "md": case "log": return "text/plain";
    case "json": return "application/json";
    case "csv": return "text/csv";
    case "html": return "text/html";
    case "zip": return "application/zip";
    case "mp3": return "audio/mpeg";
    case "ogg": return "audio/ogg";
    case "mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

/** True when a MIME type is one the model providers accept as an image block. */
export function isVisionImageType(mime: string | undefined): mime is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/gif";
}
