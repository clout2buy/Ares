// Google Sheets — read and write the owner's spreadsheets by A1 range.
//
// Values go in as USER_ENTERED, so "=SUM(B2:B9)" becomes a formula and
// "9/23/2026" a date — what the owner would get typing into the cell. Append
// inserts new rows (INSERT_ROWS) rather than overwriting whatever sits below
// the table. The owner's own sheet, undoable from version history: no ask.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { GOOGLE_API, googleJson } from "./googleApi.js";

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const inputSchema = z.object({
  action: z.enum(["read", "append", "update", "create", "info"]).describe(
    "read: values in an A1 range. append: add rows after the table in range. update: overwrite a range. " +
    "create: a new spreadsheet (title, optional header row). info: sheet tabs and sizes.",
  ),
  spreadsheet_id: z.string().optional().describe("The spreadsheet id (from its URL or GoogleDrive search)."),
  range: z.string().optional().describe("A1 range, e.g. 'Sheet1!A1:D20' or 'Sheet1' (read/append/update)."),
  values: z.array(z.array(cell)).optional().describe("Rows of cells for append/update (and create: header + rows)."),
  title: z.string().optional().describe("create: the spreadsheet title."),
});

type Input = z.infer<typeof inputSchema>;

export interface GoogleSheetsOutput {
  spreadsheet?: { id: string; title: string; url: string };
  values?: unknown[][];
  updatedRange?: string;
  sheets?: Array<{ title: string; rows?: number; columns?: number }>;
  message: string;
}

const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

function valuesUrl(id: string, range: string, suffix = ""): string {
  return `${GOOGLE_API.sheets}/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}${suffix}`;
}

function asCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map((c) => {
    const s = c === null || c === undefined ? "" : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
}

export const GoogleSheetsTool = buildTool<typeof inputSchema, GoogleSheetsOutput>({
  name: "GoogleSheets",
  description:
    "Google Sheets: read a range, append rows, update a range, create a spreadsheet, or list its tabs. " +
    "Values are entered like typing (formulas and dates work). Find a sheet's id with GoogleDrive search. Requires Google connected via Connect.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "read": return `Reading ${input.range ?? "a sheet"}`;
      case "append": return "Adding rows";
      case "update": return `Updating ${input.range ?? "a range"}`;
      case "create": return `Creating sheet: ${input.title ?? ""}`;
      case "info": return "Reading sheet tabs";
      default: return "Google Sheets";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleSheetsOutput>> {
    const fail = (message: string): ToolResult<GoogleSheetsOutput> => ({ output: { message }, display: message });
    const id = input.spreadsheet_id;
    switch (input.action) {
      case "read": {
        if (!id || !input.range) return fail("spreadsheet_id and range are required for read.");
        const data = await googleJson<{ range?: string; values?: unknown[][] }>("Sheets", valuesUrl(id, input.range));
        const values = data.values ?? [];
        return { output: { values, message: values.length ? `${data.range ?? input.range} (${values.length} rows)\n${asCsv(values.slice(0, 500))}` : `${input.range} is empty.` }, display: `${values.length} rows` };
      }
      case "append": {
        if (!id || !input.range || !input.values?.length) return fail("spreadsheet_id, range and values are required for append.");
        const data = await googleJson<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
          "Sheets",
          valuesUrl(id, input.range, ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),
          { method: "POST", body: JSON.stringify({ majorDimension: "ROWS", values: input.values }) },
        );
        const updatedRange = data.updates?.updatedRange;
        return { output: { ...(updatedRange ? { updatedRange } : {}), message: `Appended ${data.updates?.updatedRows ?? input.values.length} row(s)${updatedRange ? ` at ${updatedRange}` : ""}.` }, display: "Rows appended" };
      }
      case "update": {
        if (!id || !input.range || !input.values?.length) return fail("spreadsheet_id, range and values are required for update.");
        const data = await googleJson<{ updatedRange?: string; updatedCells?: number }>(
          "Sheets",
          valuesUrl(id, input.range, "?valueInputOption=USER_ENTERED"),
          { method: "PUT", body: JSON.stringify({ range: input.range, majorDimension: "ROWS", values: input.values }) },
        );
        return { output: { ...(data.updatedRange ? { updatedRange: data.updatedRange } : {}), message: `Updated ${data.updatedCells ?? "the"} cell(s) in ${data.updatedRange ?? input.range}.` }, display: "Range updated" };
      }
      case "create": {
        if (!input.title) return fail("title is required for create.");
        const sheet = await googleJson<{ spreadsheetId: string; properties?: { title?: string } }>("Sheets", `${GOOGLE_API.sheets}/spreadsheets`, {
          method: "POST",
          body: JSON.stringify({ properties: { title: input.title } }),
        });
        if (input.values?.length) {
          await googleJson("Sheets", valuesUrl(sheet.spreadsheetId, "A1", "?valueInputOption=USER_ENTERED"), {
            method: "PUT",
            body: JSON.stringify({ range: "A1", majorDimension: "ROWS", values: input.values }),
          });
        }
        const spreadsheet = { id: sheet.spreadsheetId, title: sheet.properties?.title ?? input.title, url: sheetUrl(sheet.spreadsheetId) };
        return { output: { spreadsheet, message: `Created "${spreadsheet.title}" — ${spreadsheet.url}` }, display: `Created ${spreadsheet.title}` };
      }
      case "info": {
        if (!id) return fail("spreadsheet_id is required for info.");
        const data = await googleJson<{ properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }> }>(
          "Sheets",
          `${GOOGLE_API.sheets}/spreadsheets/${encodeURIComponent(id)}?fields=properties.title,sheets.properties`,
        );
        const sheets = (data.sheets ?? []).map((s) => ({ title: s.properties?.title ?? "", rows: s.properties?.gridProperties?.rowCount, columns: s.properties?.gridProperties?.columnCount }));
        return { output: { spreadsheet: { id, title: data.properties?.title ?? "", url: sheetUrl(id) }, sheets, message: `${data.properties?.title ?? id}: ${sheets.map((s) => `${s.title} (${s.rows}×${s.columns})`).join(", ")}` }, display: `${sheets.length} tabs` };
      }
      default:
        return fail("Unknown action.");
    }
  },
});
