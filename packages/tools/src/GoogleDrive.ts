// Google Drive — find, read, create and share the owner's files.
//
// "Find the budget sheet and tell me Q3" is a Drive search, then a READ —
// and Google-native files have no bytes to download: Docs/Slides export as
// text, Sheets as CSV. So `read` exports natives and downloads everything
// else that is text-shaped. Sharing puts a file in front of someone else
// (Drive emails them) and deleting is permanent, so both ask; trashing asks
// too — the owner may not know where Drive's trash is.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { GOOGLE_API, capText, googleFetch, googleJson } from "./googleApi.js";

const FOLDER = "application/vnd.google-apps.folder";

/** Google-native types → the export that reads as text. */
export const DRIVE_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/svg+xml",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

/** create_file: the kind the owner asked for → the Drive mime type to convert into. */
const CREATE_AS: Record<string, string> = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  folder: FOLDER,
};

const inputSchema = z.object({
  action: z.enum(["search", "list", "read", "create_file", "share", "trash", "delete"]).describe(
    "search: find files by name/content (query). list: recent files, or a folder's contents (folder_id). " +
    "read: a file's text — Docs/Slides export as text, Sheets as CSV. " +
    "create_file: upload text as a file (kind 'file'), or create a Google Doc / Sheet (from text/CSV) / folder. " +
    "share: give someone access (email + role) — asks first. trash: move to trash — asks. delete: permanently delete — asks.",
  ),
  query: z.string().optional().describe("search: words to find in file names and contents."),
  file_id: z.string().optional().describe("File id — read, share, trash, delete."),
  folder_id: z.string().optional().describe("list: a folder's id. create_file: the parent folder."),
  name: z.string().optional().describe("create_file: the new file's name."),
  content: z.string().optional().describe("create_file: the text content (CSV for a sheet)."),
  kind: z.enum(["file", "doc", "sheet", "folder"]).optional().describe("create_file: 'file' (plain upload, default), 'doc', 'sheet' or 'folder'."),
  mime_type: z.string().optional().describe("create_file kind 'file': the uploaded content's type (default text/plain)."),
  email: z.string().optional().describe("share: who to share with."),
  role: z.enum(["reader", "commenter", "writer"]).optional().describe("share: access level (default reader)."),
  notify: z.boolean().optional().describe("share: send Google's notification email (default true)."),
  message: z.string().optional().describe("share: a note in the notification email."),
  max_results: z.number().optional().describe("search/list: max files (default 20, max 50)."),
});

type Input = z.infer<typeof inputSchema>;

interface DriveFile { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; size?: string }

export interface GoogleDriveOutput {
  files?: DriveFile[];
  file?: DriveFile;
  text?: string;
  shared?: { fileId: string; email: string; role: string };
  message: string;
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,size";

function escapeQ(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Drive's `q` for "find X": name OR full text, never trashed. */
export function driveSearchQuery(words: string): string {
  const q = escapeQ(words.trim());
  return `(name contains '${q}' or fullText contains '${q}') and trashed = false`;
}

/** multipart/related body for a metadata + media upload. */
export function driveMultipart(metadata: Record<string, unknown>, content: string, contentType: string): { body: string; boundary: string } {
  const boundary = `ares${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--`;
  return { body, boundary };
}

function describe(file: DriveFile): string {
  return `${file.name} — ${file.mimeType.replace("application/vnd.google-apps.", "google ")} [${file.id}]${file.modifiedTime ? ` · ${file.modifiedTime.slice(0, 10)}` : ""}`;
}

export const GoogleDriveTool = buildTool<typeof inputSchema, GoogleDriveOutput>({
  name: "GoogleDrive",
  description:
    "Google Drive: search and list the owner's files, read any file's text (Docs, Sheets as CSV, Slides, text files), " +
    "upload or create files/Docs/Sheets/folders, share a file with someone, trash or delete. Requires Google connected via Connect.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  async checkPermissions(input) {
    if (input.action === "share")
      return { kind: "ask", prompt: `Share Drive file ${input.file_id ?? "?"} with ${input.email ?? "someone"} as ${input.role ?? "reader"}${input.notify === false ? "" : " (Google emails them)"}${input.message ? `\nNote: ${input.message}` : ""}`, suggestion: "allow_once" };
    if (input.action === "delete") return { kind: "ask", prompt: `PERMANENTLY delete Drive file ${input.file_id ?? "?"} (skips the trash)`, suggestion: "allow_once" };
    if (input.action === "trash") return { kind: "ask", prompt: `Move Drive file ${input.file_id ?? "?"} to the trash`, suggestion: "allow_once" };
    return { kind: "allow" };
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "search": return `Searching Drive: ${input.query ?? ""}`;
      case "list": return "Listing Drive files";
      case "read": return "Reading a Drive file";
      case "create_file": return `Creating ${input.name ?? "a file"} in Drive`;
      case "share": return `Sharing with ${input.email ?? ""}`;
      case "trash": return "Trashing a Drive file";
      case "delete": return "Deleting a Drive file";
      default: return "Google Drive";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleDriveOutput>> {
    const need = (field: keyof Input): ToolResult<GoogleDriveOutput> | null =>
      input[field] ? null : { output: { message: `${String(field)} is required for ${input.action}.` }, display: `Missing ${String(field)}.` };
    const max = String(Math.min(input.max_results ?? 20, 50));

    switch (input.action) {
      case "search":
      case "list": {
        if (input.action === "search") {
          const missing = need("query");
          if (missing) return missing;
        }
        const q = input.action === "search"
          ? driveSearchQuery(input.query!)
          : input.folder_id ? `'${escapeQ(input.folder_id)}' in parents and trashed = false` : "trashed = false";
        const params = new URLSearchParams({ q, pageSize: max, fields: `files(${FILE_FIELDS})`, supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
        if (input.action === "list") params.set("orderBy", "modifiedTime desc");
        const data = await googleJson<{ files?: DriveFile[] }>("Drive", `${GOOGLE_API.drive}/files?${params}`);
        const files = data.files ?? [];
        return { output: { files, message: files.length ? files.map(describe).join("\n") : "No files found." }, display: `${files.length} files` };
      }

      case "read": {
        const missing = need("file_id");
        if (missing) return missing;
        const id = encodeURIComponent(input.file_id!);
        const file = await googleJson<DriveFile>("Drive", `${GOOGLE_API.drive}/files/${id}?fields=${FILE_FIELDS}&supportsAllDrives=true`);
        const exportAs = DRIVE_EXPORTS[file.mimeType];
        let text: string;
        if (exportAs) {
          text = await (await googleFetch("Drive", `${GOOGLE_API.drive}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`)).text();
        } else if (file.mimeType === FOLDER) {
          return { output: { file, message: `${file.name} is a folder — use list with folder_id ${file.id}.` }, display: "That is a folder" };
        } else if (/^(text\/|application\/(json|xml|csv|javascript|x-yaml|yaml))/.test(file.mimeType)) {
          text = await (await googleFetch("Drive", `${GOOGLE_API.drive}/files/${id}?alt=media&supportsAllDrives=true`)).text();
        } else {
          return { output: { file, message: `${file.name} is ${file.mimeType}; it has no text to read here. Link: ${file.webViewLink ?? "(none)"}` }, display: "Not a text file" };
        }
        return { output: { file, text: capText(text, 40_000), message: `${describe(file)}\n\n${capText(text, 40_000)}` }, display: file.name };
      }

      case "create_file": {
        const missing = need("name");
        if (missing) return missing;
        const kind = input.kind ?? "file";
        const metadata: Record<string, unknown> = { name: input.name, ...(input.folder_id ? { parents: [input.folder_id] } : {}) };
        let file: DriveFile;
        if (kind === "folder") {
          file = await googleJson<DriveFile>("Drive", `${GOOGLE_API.drive}/files?fields=${FILE_FIELDS}&supportsAllDrives=true`, { method: "POST", body: JSON.stringify({ ...metadata, mimeType: FOLDER }) });
        } else {
          // Uploading text with a Google-native target mime type converts it:
          // text → Doc, CSV → Sheet.
          if (kind !== "file") metadata.mimeType = CREATE_AS[kind];
          const contentType = kind === "sheet" ? "text/csv" : kind === "doc" ? "text/plain" : input.mime_type ?? "text/plain";
          const { body, boundary } = driveMultipart(metadata, input.content ?? "", contentType);
          file = await googleJson<DriveFile>("Drive", `${GOOGLE_API.driveUpload}/files?uploadType=multipart&fields=${FILE_FIELDS}&supportsAllDrives=true`, {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body,
          });
        }
        return { output: { file, message: `Created ${describe(file)}${file.webViewLink ? `\n${file.webViewLink}` : ""}` }, display: `Created ${file.name}` };
      }

      case "share": {
        const missing = need("file_id") ?? need("email");
        if (missing) return missing;
        const role = input.role ?? "reader";
        const params = new URLSearchParams({ supportsAllDrives: "true", sendNotificationEmail: String(input.notify !== false) });
        if (input.message && input.notify !== false) params.set("emailMessage", input.message);
        await googleFetch("Drive", `${GOOGLE_API.drive}/files/${encodeURIComponent(input.file_id!)}/permissions?${params}`, {
          method: "POST",
          body: JSON.stringify({ type: "user", role, emailAddress: input.email }),
        });
        return { output: { shared: { fileId: input.file_id!, email: input.email!, role }, message: `Shared with ${input.email} as ${role}.` }, display: `Shared with ${input.email}` };
      }

      case "trash": {
        const missing = need("file_id");
        if (missing) return missing;
        await googleFetch("Drive", `${GOOGLE_API.drive}/files/${encodeURIComponent(input.file_id!)}?supportsAllDrives=true`, { method: "PATCH", body: JSON.stringify({ trashed: true }) });
        return { output: { message: "Moved to Drive's trash (restorable for 30 days)." }, display: "Trashed" };
      }

      case "delete": {
        const missing = need("file_id");
        if (missing) return missing;
        await googleFetch("Drive", `${GOOGLE_API.drive}/files/${encodeURIComponent(input.file_id!)}?supportsAllDrives=true`, { method: "DELETE" });
        return { output: { message: "Permanently deleted." }, display: "Deleted" };
      }

      default:
        return { output: { message: "Unknown action." }, display: "Unknown action." };
    }
  },
});
