// Telegram — let the agent PUSH to the owner's phone: a photo, a file, or a
// message. The bridge already renders the reply text of a Telegram turn; this
// tool is for everything the reply can't carry — the screenshot of a listing,
// the PDF it just made, "found it, here's the link" while a long task keeps
// running — and it works from ANY surface: from the desktop, "send that to my
// phone" lands on Telegram too.
//
// The live bridge is injected at daemon start (like Remind's scheduler); in a
// process with no Telegram the tool degrades to a clear "not configured".

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    action: z.enum(["photo", "file", "message"]).describe(
      "photo: send an image file inline (PNG/JPEG/WebP/GIF). file: send any file as a document (PDF, txt, csv, zip…). message: send a text message right now (useful mid-task).",
    ),
    path: z.string().optional().describe("Path of the image/file to send (absolute, or relative to the workspace). Required for photo/file."),
    caption: z.string().max(1024).optional().describe("Short caption shown under the photo/file."),
    text: z.string().max(4000).optional().describe("Message body. Required for 'message'."),
    to: z.enum(["chat", "owner"]).optional().describe(
      "chat (default): the Telegram chat this session belongs to — or the owner's phone when the session isn't a Telegram one. owner: always the owner's phone(s).",
    ),
  })
  .strict();

export interface TelegramOutput {
  action: string;
  ok: boolean;
  chats?: number[];
  bytes?: number;
  note?: string;
}

/** What the tool needs from the live bridge — TelegramBridge satisfies it. */
export interface TelegramChannelLike {
  chatForSession(sessionId: string): number | undefined;
  ownerChats(): number[];
  sendTextTo(chatId: number, text: string): Promise<void>;
  sendPhotoTo(chatId: number, image: Buffer, opts?: { caption?: string; filename?: string }): Promise<void>;
  sendDocumentTo(chatId: number, file: Buffer, opts?: { caption?: string; filename?: string }): Promise<void>;
}

let channelRef: TelegramChannelLike | null = null;

export function setTelegramChannel(channel: TelegramChannelLike | null): void {
  channelRef = channel;
}

export function getTelegramChannel(): TelegramChannelLike | null {
  return channelRef;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export const TelegramTool = buildTool({
  name: "Telegram",
  description:
    "Send something to the user's phone over Telegram: a photo (screenshot, product image, chart), a file (PDF, report, log, zip), or a text message. " +
    "Use it whenever the user needs to SEE a result rather than read a description — 'show me', 'send me a pic', 'shoot me the listing', a screenshot after driving the browser or their PC. " +
    "On a Telegram conversation it goes to that chat; from the desktop/terminal it goes to the owner's phone. " +
    "Reply text is delivered by the bridge automatically — only use 'message' for something worth sending BEFORE the turn ends (a heads-up mid-task).",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => {
    if (i.action === "photo") return `Sending photo ${i.path ? path.basename(i.path) : ""} to Telegram`;
    if (i.action === "file") return `Sending file ${i.path ? path.basename(i.path) : ""} to Telegram`;
    return "Sending a Telegram message";
  },

  async call(i, ctx): Promise<{ output: TelegramOutput; display: string }> {
    if (!channelRef) {
      return {
        output: { action: i.action, ok: false, note: "Telegram isn't connected in this process — set it up with 'connect telegram' and make sure the garrison is running." },
        display: "Telegram not connected.",
      };
    }
    const chats = resolveTargets(channelRef, ctx.sessionId, i.to);
    if (chats.length === 0) {
      return { output: { action: i.action, ok: false, note: "No Telegram chat to send to (no owner chat configured)." }, display: "No Telegram chat to send to." };
    }

    if (i.action === "message") {
      if (!i.text?.trim()) throw new Error("message needs text.");
      await Promise.all(chats.map((id) => channelRef!.sendTextTo(id, i.text!)));
      return { output: { action: "message", ok: true, chats }, display: `📨 Sent to Telegram (${chats.length} chat${chats.length === 1 ? "" : "s"}).` };
    }

    if (!i.path) throw new Error(`${i.action} needs a path.`);
    const resolved = path.resolve(ctx.workspace, i.path);
    const info = await fs.stat(resolved).catch(() => null);
    if (!info?.isFile()) throw new Error(`No such file: ${resolved}`);
    const limit = i.action === "photo" ? MAX_PHOTO_BYTES : MAX_FILE_BYTES;
    if (info.size > limit) throw new Error(`${path.basename(resolved)} is ${(info.size / 1048576).toFixed(1)}MB; Telegram's limit for a ${i.action} is ${limit / 1048576}MB.`);
    if (i.action === "photo" && !IMAGE_EXT.test(resolved)) throw new Error("photo needs a PNG, JPEG, WebP, or GIF — use 'file' for anything else.");
    const bytes = await fs.readFile(resolved);
    const filename = path.basename(resolved);
    const opts = { caption: i.caption, filename };
    await Promise.all(
      chats.map((id) => (i.action === "photo" ? channelRef!.sendPhotoTo(id, bytes, opts) : channelRef!.sendDocumentTo(id, bytes, opts))),
    );
    const kb = Math.round(bytes.byteLength / 1024);
    return {
      output: { action: i.action, ok: true, chats, bytes: bytes.byteLength },
      display: `${i.action === "photo" ? "🖼" : "📎"} Sent ${filename} (${kb}KB) to Telegram.`,
    };
  },
});

/** The session's own chat when it is a Telegram session; otherwise the owners. */
export function resolveTargets(channel: TelegramChannelLike, sessionId: string | undefined, to: "chat" | "owner" | undefined): number[] {
  if (to !== "owner" && sessionId) {
    const own = channel.chatForSession(sessionId);
    if (own !== undefined) return [own];
  }
  return channel.ownerChats();
}
