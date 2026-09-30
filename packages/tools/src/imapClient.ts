// The IMAP / SMTP transport for the Mail tool.
//
// Libraries: imapflow (MIT; the maintained IMAP client by the Nodemailer
// author: promise API, SPECIAL-USE, UID commands, bounded fetches), nodemailer
// (MIT-0; SMTP with STARTTLS / implicit TLS) and mailparser (MIT; RFC 822 to
// text/attachments). All three are loaded lazily so a Mail-less session never
// pays for them.
//
// One short-lived connection per operation (connect, act, log out): a mail
// tool is called a few times a session, and a held-open IDLE socket would be a
// liability on a box that sleeps. Every connection has connect/greeting/socket
// timeouts and an overall deadline that tears the socket down.
//
// TLS: port 993 is implicit TLS; every other IMAP port is STARTTLS. For a
// non-private host STARTTLS is REQUIRED (a password never crosses the open
// internet in clear). For loopback / LAN hosts it is opportunistic and a
// self-signed certificate is accepted: Proton Mail Bridge, Dovecot on a home
// server and test containers all look like that.

import { DAV_LIMITS, DavError, classifyError, isLoopbackHost, isPrivateHost, oneLine, redact, type ErrorContext, type MailAccount } from "./davCommon.js";
import { htmlToText } from "./oneTimeCode.js";

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  messages?: number;
  unseen?: number;
}

export interface MessageSummary {
  folder: string;
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
  flagged: boolean;
  size?: number;
  snippet?: string;
}

export interface AttachmentInfo {
  filename: string;
  type: string;
  size: number;
}

export interface MessageBody extends MessageSummary {
  cc?: string;
  messageId?: string;
  body: string;
  truncated: boolean;
  attachments: AttachmentInfo[];
}

export interface SearchQuery {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
}

export interface ReplyContext {
  messageId?: string;
  references?: string;
  subject: string;
  replyTo: string[];
  from: string[];
  to: string[];
  cc: string[];
  date?: string;
  quoted: string;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  /** Also file a copy in Sent (skipped for servers that do it themselves). */
  saveCopy: boolean;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  savedToSent: boolean;
}

export interface MailBackend {
  listFolders(): Promise<FolderInfo[]>;
  listMessages(folder: string, q: { limit: number; unreadOnly?: boolean }): Promise<{ total: number; messages: MessageSummary[] }>;
  search(folder: string, q: SearchQuery, limit: number): Promise<{ total: number; messages: MessageSummary[] }>;
  read(folder: string, uid: number): Promise<MessageBody | undefined>;
  replyContext(folder: string, uid: number): Promise<ReplyContext | undefined>;
  setFlags(folder: string, uid: number, change: { add?: string[]; remove?: string[] }): Promise<void>;
  move(folder: string, uid: number, destination: string): Promise<{ destination: string }>;
  send(mail: OutgoingMail): Promise<SendResult>;
}

/** Test seam: replace the real network backend. Production leaves it unset. */
export const mailSeams: { backend?: (account: MailAccount) => MailBackend } = {};

// ─── plumbing ────────────────────────────────────────────────────────────────

type ImapFlowModule = typeof import("imapflow");
type ImapClient = InstanceType<ImapFlowModule["ImapFlow"]>;

async function loadImapFlow(): Promise<ImapFlowModule> {
  const mod = (await import("imapflow")) as ImapFlowModule & { default?: ImapFlowModule };
  return mod.ImapFlow ? mod : (mod.default as ImapFlowModule);
}

function mailCtx(service: "IMAP" | "SMTP", account: MailAccount): ErrorContext {
  const host = service === "IMAP" ? account.imap.host : account.smtp.host;
  return { service, host, provider: account.id, secrets: [account.password, ...account.users.map((u) => Buffer.from(`\0${u}\0${account.password}`).toString("base64"))] };
}

function imapOptions(account: MailAccount, user: string) {
  const { host, port, secure } = account.imap;
  const priv = isPrivateHost(host);
  return {
    host,
    port,
    secure,
    auth: { user, pass: account.password },
    logger: false as const,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: DAV_LIMITS.timeoutMs + 20_000,
    maxLiteralSize: DAV_LIMITS.maxMessageBytes * 4,
    maxResponseSize: DAV_LIMITS.maxMessageBytes * 8,
    // Non-private hosts must negotiate TLS; private ones may fall back (Bridge, LAN).
    ...(secure ? {} : { doSTARTTLS: priv ? undefined : true }),
    tls: { rejectUnauthorized: !isLoopbackHost(host) && !host.endsWith(".local") },
  };
}

/** Connect (trying each login for iCloud-style accounts), run, always log out. */
async function withImap<T>(account: MailAccount, run: (client: ImapClient) => Promise<T>): Promise<T> {
  const ctx = mailCtx("IMAP", account);
  const { ImapFlow } = await loadImapFlow();
  let lastErr: unknown;
  for (const user of account.users) {
    const client = new ImapFlow(imapOptions(account, user));
    client.on("error", () => undefined); // a socket error after the fact must not crash the process
    const deadline = setTimeout(() => {
      try {
        client.close();
      } catch {
        // already closed
      }
    }, 90_000);
    try {
      await client.connect();
    } catch (err) {
      clearTimeout(deadline);
      lastErr = err;
      try {
        client.close();
      } catch {
        // not connected
      }
      const c = classifyError(err, ctx);
      if ((c.kind === "auth" || c.kind === "app-password") && user !== account.users[account.users.length - 1]) continue;
      throw c;
    }
    try {
      return await run(client);
    } catch (err) {
      throw classifyError(err, ctx);
    } finally {
      clearTimeout(deadline);
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          // gone
        }
      }
    }
  }
  throw classifyError(lastErr, ctx);
}

// ─── formatting ──────────────────────────────────────────────────────────────

type Addr = { name?: string; address?: string };

function addrText(list: Addr[] | undefined, max = 4): string {
  const out = (list ?? []).slice(0, max).map((a) => (a.name && a.address ? `${oneLine(a.name, 60)} <${a.address}>` : (a.address ?? oneLine(a.name ?? "", 60))));
  const extra = (list?.length ?? 0) - out.length;
  return oneLine(out.join(", ") + (extra > 0 ? ` +${extra} more` : ""), 240);
}

function isoDate(d: Date | string | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** QP / base64 / 7bit body part to text, honouring the declared charset. */
export function decodePart(buf: Buffer, encoding: string | undefined, charset: string | undefined): string {
  let raw = buf;
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "base64") raw = Buffer.from(buf.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  else if (enc === "quoted-printable") {
    const text = buf.toString("latin1").replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(text.charCodeAt(i) & 0xff);
    }
    raw = Buffer.from(bytes);
  }
  try {
    return new TextDecoder((charset || "utf-8").toLowerCase(), { fatal: false }).decode(raw);
  } catch {
    return raw.toString("utf8");
  }
}

interface StructNode {
  part?: string;
  type: string;
  encoding?: string;
  parameters?: { [key: string]: string };
  disposition?: string;
  childNodes?: StructNode[];
  size?: number;
}

/** The part to excerpt for a snippet: text/plain, else text/html. */
function snippetPart(node: StructNode | undefined): { part: string; type: string; encoding?: string; charset?: string } | undefined {
  if (!node) return undefined;
  const found: Array<{ part: string; type: string; encoding?: string; charset?: string }> = [];
  const walk = (n: StructNode): void => {
    if (n.childNodes?.length) {
      n.childNodes.forEach(walk);
      return;
    }
    const type = n.type.toLowerCase();
    if ((type === "text/plain" || type === "text/html") && n.disposition?.toLowerCase() !== "attachment") {
      found.push({ part: n.part ?? "1", type, encoding: n.encoding, charset: n.parameters?.charset });
    }
  };
  walk(node);
  return found.find((f) => f.type === "text/plain") ?? found[0];
}

function hasAttachment(node: StructNode | undefined): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === "attachment") return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

function folderPathOf(folders: Array<{ path: string; name: string; specialUse?: string }>, wanted: string): string | undefined {
  const w = wanted.trim().toLowerCase();
  if (!w) return undefined;
  const direct = folders.find((f) => f.path.toLowerCase() === w) ?? folders.find((f) => f.name.toLowerCase() === w);
  if (direct) return direct.path;
  const aliases: Record<string, string[]> = {
    inbox: ["\\Inbox"], trash: ["\\Trash"], "deleted messages": ["\\Trash"], bin: ["\\Trash"], archive: ["\\Archive"], "all mail": ["\\All"],
    junk: ["\\Junk"], spam: ["\\Junk"], sent: ["\\Sent"], "sent messages": ["\\Sent"], "sent items": ["\\Sent"], drafts: ["\\Drafts"],
  };
  for (const use of aliases[w] ?? []) {
    const hit = folders.find((f) => f.specialUse === use);
    if (hit) return hit.path;
  }
  return undefined;
}

// ─── the real backend ────────────────────────────────────────────────────────

export function realMailBackend(account: MailAccount): MailBackend {
  const summarize = async (client: ImapClient, folder: string, uids: number[]): Promise<MessageSummary[]> => {
    if (!uids.length) return [];
    const rows = new Map<number, MessageSummary>();
    const parts = new Map<number, ReturnType<typeof snippetPart>>();
    for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true }, { uid: true })) {
      const env = msg.envelope;
      rows.set(msg.uid, {
        folder,
        uid: msg.uid,
        from: addrText(env?.from, 2),
        to: addrText(env?.to, 3),
        subject: oneLine(env?.subject ?? "(no subject)", 200),
        date: isoDate(env?.date ?? msg.internalDate),
        unread: !msg.flags?.has("\\Seen"),
        flagged: Boolean(msg.flags?.has("\\Flagged")),
        ...(msg.size !== undefined ? { size: msg.size } : {}),
      });
      parts.set(msg.uid, snippetPart(msg.bodyStructure as StructNode | undefined));
    }
    // Snippets: one small ranged fetch per message (pipelined on one connection).
    for (const uid of uids) {
      const row = rows.get(uid);
      const part = parts.get(uid);
      if (!row || !part) continue;
      try {
        const m = await client.fetchOne(String(uid), { uid: true, bodyParts: [{ key: part.part, maxLength: 1200 }] }, { uid: true });
        const buf = m && m.bodyParts?.get(part.part);
        if (buf) {
          const text = decodePart(buf, part.encoding, part.charset);
          const plain = part.type === "text/html" ? htmlToText(text) : text;
          const snippet = oneLine(plain.replace(/\s+/g, " "), 200);
          if (snippet) row.snippet = snippet;
        }
      } catch {
        // a snippet is a nicety
      }
    }
    return uids.map((u) => rows.get(u)).filter((r): r is MessageSummary => Boolean(r));
  };

  const resolve = async (client: ImapClient, folder: string): Promise<string> => {
    const list = await client.list();
    const path = folderPathOf(list, folder);
    if (!path) throw new DavError("not-found", `There is no mail folder called "${oneLine(folder, 60)}". Use list_folders to see the names.`);
    return path;
  };

  return {
    async listFolders() {
      return withImap(account, async (client) => {
        const list = await client.list({ statusQuery: { messages: true, unseen: true } });
        return list
          .filter((f) => !f.flags.has("\\Noselect"))
          .slice(0, DAV_LIMITS.maxFolders)
          .map((f) => ({
            path: f.path,
            name: f.name,
            ...(f.specialUse ? { specialUse: f.specialUse } : {}),
            ...(f.status?.messages !== undefined ? { messages: f.status.messages } : {}),
            ...(f.status?.unseen !== undefined ? { unseen: f.status.unseen } : {}),
          }));
      });
    },

    async listMessages(folder, q) {
      return withImap(account, async (client) => {
        const path = await resolve(client, folder);
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try {
          const found = await client.search(q.unreadOnly ? { seen: false } : { all: true }, { uid: true });
          const uids = Array.isArray(found) ? found : [];
          const page = uids.slice(-q.limit).reverse();
          return { total: uids.length, messages: await summarize(client, path, page) };
        } finally {
          lock.release();
        }
      });
    },

    async search(folder, q, limit) {
      return withImap(account, async (client) => {
        const path = await resolve(client, folder);
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try {
          const query: Record<string, unknown> = {};
          if (q.from) query.from = q.from;
          if (q.to) query.to = q.to;
          if (q.subject) query.subject = q.subject;
          if (q.text) query.text = q.text;
          if (q.since) query.since = q.since;
          if (q.before) query.before = q.before;
          if (q.unreadOnly) query.seen = false;
          if (q.flaggedOnly) query.flagged = true;
          if (!Object.keys(query).length) query.all = true;
          const found = await client.search(query as never, { uid: true });
          const uids = Array.isArray(found) ? found : [];
          const page = uids.slice(-limit).reverse();
          return { total: uids.length, messages: await summarize(client, path, page) };
        } finally {
          lock.release();
        }
      });
    },

    async read(folder, uid) {
      return withImap(account, async (client) => {
        const path = await resolve(client, folder);
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try {
          const msg = await client.fetchOne(String(uid), { uid: true, flags: true, size: true, internalDate: true, source: { start: 0, maxLength: DAV_LIMITS.maxMessageBytes } }, { uid: true });
          if (!msg || !msg.source) return undefined;
          const { simpleParser } = await import("mailparser");
          const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
          let body = (parsed.text ?? "").trim();
          if (!body && typeof parsed.html === "string") body = htmlToText(parsed.html);
          const truncated = body.length > DAV_LIMITS.maxBodyChars || (msg.size ?? 0) > DAV_LIMITS.maxMessageBytes;
          const addr = (v: unknown): string => {
            const values = Array.isArray(v) ? v.flatMap((x) => (x as { value?: Addr[] }).value ?? []) : ((v as { value?: Addr[] } | undefined)?.value ?? []);
            return addrText(values, 10);
          };
          return {
            folder: path,
            uid,
            from: addr(parsed.from),
            to: addr(parsed.to),
            ...(parsed.cc ? { cc: addr(parsed.cc) } : {}),
            subject: oneLine(parsed.subject ?? "(no subject)", 300),
            date: isoDate(parsed.date ?? msg.internalDate),
            unread: !msg.flags?.has("\\Seen"),
            flagged: Boolean(msg.flags?.has("\\Flagged")),
            ...(msg.size !== undefined ? { size: msg.size } : {}),
            ...(parsed.messageId ? { messageId: oneLine(parsed.messageId, 200) } : {}),
            body: body.length > DAV_LIMITS.maxBodyChars ? `${body.slice(0, DAV_LIMITS.maxBodyChars)}…` : body,
            truncated,
            attachments: parsed.attachments.slice(0, 20).map((a) => ({ filename: oneLine(a.filename ?? "(unnamed)", 120), type: oneLine(a.contentType ?? "application/octet-stream", 80), size: a.size ?? 0 })),
          } satisfies MessageBody;
        } finally {
          lock.release();
        }
      });
    },

    async replyContext(folder, uid) {
      return withImap(account, async (client) => {
        const path = await resolve(client, folder);
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try {
          const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, headers: ["references", "reply-to"], source: { start: 0, maxLength: 60_000 } }, { uid: true });
          if (!msg || !msg.envelope) return undefined;
          const env = msg.envelope;
          const headers = msg.headers?.toString("utf8") ?? "";
          const references = /^references:\s*([\s\S]*?)(?=\r?\n\S|$)/im.exec(headers)?.[1]?.replace(/\s+/g, " ").trim();
          const list = (a?: Addr[]): string[] => (a ?? []).map((x) => x.address ?? "").filter(Boolean);
          let quoted = "";
          if (msg.source) {
            const { simpleParser } = await import("mailparser");
            const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
            quoted = ((parsed.text ?? "").trim() || (typeof parsed.html === "string" ? htmlToText(parsed.html) : "")).slice(0, 3000);
          }
          return {
            ...(env.messageId ? { messageId: env.messageId } : {}),
            ...(references ? { references } : {}),
            subject: oneLine(env.subject ?? "", 300),
            replyTo: list(env.replyTo),
            from: list(env.from),
            to: list(env.to),
            cc: list(env.cc),
            ...(env.date ? { date: isoDate(env.date) } : {}),
            quoted,
          } satisfies ReplyContext;
        } finally {
          lock.release();
        }
      });
    },

    async setFlags(folder, uid, change) {
      return withImap(account, async (client) => {
        const path = await resolve(client, folder);
        const lock = await client.getMailboxLock(path);
        try {
          if (change.add?.length) await client.messageFlagsAdd(String(uid), change.add, { uid: true });
          if (change.remove?.length) await client.messageFlagsRemove(String(uid), change.remove, { uid: true });
        } finally {
          lock.release();
        }
      });
    },

    async move(folder, uid, destination) {
      return withImap(account, async (client) => {
        const list = await client.list();
        const from = folderPathOf(list, folder);
        const to = folderPathOf(list, destination);
        if (!from) throw new DavError("not-found", `There is no mail folder called "${oneLine(folder, 60)}".`);
        if (!to) throw new DavError("not-found", `There is no mail folder called "${oneLine(destination, 60)}". Use list_folders to see the names.`);
        const lock = await client.getMailboxLock(from);
        try {
          const res = await client.messageMove(String(uid), to, { uid: true });
          if (!res) throw new DavError("server", "The server did not confirm the move.");
          return { destination: to };
        } finally {
          lock.release();
        }
      });
    },

    async send(mail) {
      const ctx = mailCtx("SMTP", account);
      try {
        const nodemailer = await import("nodemailer");
        const lib = (nodemailer as unknown as { default?: typeof nodemailer }).default ?? nodemailer;
        const { host, port, secure } = account.smtp;
        const local = isPrivateHost(host);
        const message = {
          from: mail.from,
          to: mail.to,
          ...(mail.cc?.length ? { cc: mail.cc } : {}),
          ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
          subject: mail.subject,
          text: mail.text,
          ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
          ...(mail.references ? { references: mail.references } : {}),
        };
        // Build the exact bytes once: what is sent is what is filed in Sent.
        const builder = lib.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
        const built = (await builder.sendMail(message)) as unknown as { message: Buffer; messageId: string };
        const envelope = { from: mail.from.replace(/^.*<([^>]+)>.*$/, "$1"), to: [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])].map((a) => a.replace(/^.*<([^>]+)>.*$/, "$1")) };
        const transporter = lib.createTransport({
          host,
          port,
          secure,
          requireTLS: !secure && !local,
          auth: { user: account.smtpUser, pass: account.password },
          tls: { rejectUnauthorized: !isLoopbackHost(host) && !host.endsWith(".local") },
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 40_000,
          logger: false,
        });
        let info: { accepted: unknown[]; rejected: unknown[]; messageId?: string };
        try {
          info = (await transporter.sendMail({ envelope, raw: built.message })) as typeof info;
        } finally {
          transporter.close();
        }
        let savedToSent = false;
        if (mail.saveCopy) {
          try {
            savedToSent = await withImap(account, async (client) => {
              const list = await client.list();
              const sent = folderPathOf(list, "sent");
              if (!sent) return false;
              return Boolean(await client.append(sent, built.message, ["\\Seen"]));
            });
          } catch {
            savedToSent = false;
          }
        }
        return {
          messageId: info.messageId ?? built.messageId,
          accepted: info.accepted.map(String).slice(0, 50),
          rejected: info.rejected.map(String).slice(0, 50),
          savedToSent,
        };
      } catch (err) {
        throw classifyError(err, ctx);
      }
    },
  };
}

export function mailBackendFor(account: MailAccount): MailBackend {
  return (mailSeams.backend ?? realMailBackend)(account);
}

// ─── verification (connect hub) ──────────────────────────────────────────────

export interface MailProbe {
  folders: number;
  hasNotes: boolean;
  /** Undefined when SMTP login worked. */
  smtpProblem?: string;
  imapLogin: string;
}

/** Real, read-only login: IMAP LIST, then an SMTP connect+AUTH (no message is sent). */
export async function probeMail(account: MailAccount, signal?: AbortSignal): Promise<MailProbe> {
  const { ImapFlow } = await loadImapFlow();
  const ctx = mailCtx("IMAP", account);
  let folders: Array<{ path: string; name: string }> = [];
  let login = "";
  let lastErr: unknown;
  for (const user of account.users) {
    const client = new ImapFlow({ ...imapOptions(account, user), connectionTimeout: 10_000, greetingTimeout: 10_000 });
    client.on("error", () => undefined);
    const abort = (): void => {
      try {
        client.close();
      } catch {
        // closed
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      folders = await client.list();
      login = user;
      await client.logout().catch(() => abort());
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      abort();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  if (lastErr !== undefined) throw classifyError(lastErr, ctx);
  const probe: MailProbe = { folders: folders.length, hasNotes: folders.some((f) => f.name.toLowerCase() === "notes"), imapLogin: login };
  try {
    const nodemailer = await import("nodemailer");
    const lib = (nodemailer as unknown as { default?: typeof nodemailer }).default ?? nodemailer;
    const { host, port, secure } = account.smtp;
    const transporter = lib.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure && !isPrivateHost(host),
      auth: { user: account.smtpUser, pass: account.password },
      tls: { rejectUnauthorized: !isLoopbackHost(host) && !host.endsWith(".local") },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      logger: false,
    });
    try {
      await transporter.verify();
    } finally {
      transporter.close();
    }
  } catch (err) {
    probe.smtpProblem = redact(classifyError(err, mailCtx("SMTP", account)).message, [account.password]);
  }
  return probe;
}
