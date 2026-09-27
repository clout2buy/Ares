// Google Docs — create, read and edit the owner's documents.
//
// The Docs API edits by index, which is a trap for a model: an insert at a
// stale index lands mid-word. So the tool offers only index-free edits —
// append at the end of the body (endOfSegmentLocation) and replace-all by
// matching text — which are the two edits people actually ask for. Edits to
// the owner's own doc are private and undoable from version history, so
// none of this asks; sharing a doc goes through GoogleDrive share, which does.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { GOOGLE_API, capText, googleJson } from "./googleApi.js";

const inputSchema = z.object({
  action: z.enum(["create", "read", "append", "replace"]).describe(
    "create: a new Doc (title, optional initial text). read: a Doc's text. " +
    "append: add text at the end. replace: replace every occurrence of find with text.",
  ),
  document_id: z.string().optional().describe("The Doc's id (from its URL or GoogleDrive search) — read/append/replace."),
  title: z.string().optional().describe("create: the Doc's title."),
  text: z.string().optional().describe("create: initial text. append: text to add. replace: the replacement."),
  find: z.string().optional().describe("replace: the exact text to find (case-sensitive unless match_case is false)."),
  match_case: z.boolean().optional().describe("replace: default true."),
});

type Input = z.infer<typeof inputSchema>;

export interface GoogleDocsOutput {
  document?: { id: string; title: string; url: string };
  text?: string;
  replaced?: number;
  message: string;
}

interface DocElement { paragraph?: { elements?: Array<{ textRun?: { content?: string } }> }; table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocElement[] }> }> } }
interface Doc { documentId: string; title: string; body?: { content?: DocElement[] } }

/** Flatten a Docs `body.content` tree (paragraphs and tables) to plain text. */
export function docText(content: DocElement[] | undefined): string {
  let out = "";
  for (const el of content ?? []) {
    for (const run of el.paragraph?.elements ?? []) out += run.textRun?.content ?? "";
    for (const row of el.table?.tableRows ?? []) {
      out += row.tableCells?.map((cell) => docText(cell.content).trim()).join("\t") ?? "";
      out += "\n";
    }
  }
  return out;
}

const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

async function batchUpdate(documentId: string, requests: unknown[]): Promise<{ replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> }> {
  return googleJson("Docs", `${GOOGLE_API.docs}/documents/${encodeURIComponent(documentId)}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
}

export const GoogleDocsTool = buildTool<typeof inputSchema, GoogleDocsOutput>({
  name: "GoogleDocs",
  description:
    "Google Docs: create a document, read a document's text, append text, or find-and-replace text. " +
    "Find a Doc's id with GoogleDrive search. Requires Google connected via Connect.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "create": return `Creating doc: ${input.title ?? ""}`;
      case "read": return "Reading a doc";
      case "append": return "Adding to a doc";
      case "replace": return "Editing a doc";
      default: return "Google Docs";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleDocsOutput>> {
    const fail = (message: string): ToolResult<GoogleDocsOutput> => ({ output: { message }, display: message });
    switch (input.action) {
      case "create": {
        if (!input.title) return fail("title is required for create.");
        const doc = await googleJson<Doc>("Docs", `${GOOGLE_API.docs}/documents`, { method: "POST", body: JSON.stringify({ title: input.title }) });
        if (input.text) await batchUpdate(doc.documentId, [{ insertText: { location: { index: 1 }, text: input.text } }]);
        const document = { id: doc.documentId, title: doc.title, url: docUrl(doc.documentId) };
        return { output: { document, message: `Created "${doc.title}" — ${document.url}` }, display: `Created ${doc.title}` };
      }
      case "read": {
        if (!input.document_id) return fail("document_id is required for read.");
        const doc = await googleJson<Doc>("Docs", `${GOOGLE_API.docs}/documents/${encodeURIComponent(input.document_id)}`);
        const text = docText(doc.body?.content);
        return { output: { document: { id: doc.documentId, title: doc.title, url: docUrl(doc.documentId) }, text: capText(text, 40_000), message: `${doc.title}\n\n${capText(text, 40_000)}` }, display: doc.title };
      }
      case "append": {
        if (!input.document_id || !input.text) return fail("document_id and text are required for append.");
        await batchUpdate(input.document_id, [{ insertText: { endOfSegmentLocation: {}, text: input.text } }]);
        return { output: { message: `Appended ${input.text.length} chars — ${docUrl(input.document_id)}` }, display: "Appended" };
      }
      case "replace": {
        if (!input.document_id || !input.find || input.text === undefined) return fail("document_id, find and text are required for replace.");
        const res = await batchUpdate(input.document_id, [{ replaceAllText: { containsText: { text: input.find, matchCase: input.match_case !== false }, replaceText: input.text } }]);
        const replaced = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return { output: { replaced, message: replaced ? `Replaced ${replaced} occurrence(s).` : `"${input.find}" was not found — nothing changed.` }, display: `${replaced} replaced` };
      }
      default:
        return fail("Unknown action.");
    }
  },
});
