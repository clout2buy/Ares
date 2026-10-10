// Google Docs API v1 and Sheets API v4 operations of the Google preset. Curated from the
// discovery documents https://docs.googleapis.com/$discovery/rest?version=v1 and
// https://sheets.googleapis.com/$discovery/rest?version=v4 (both fetched 2026-09-30).
// Hosts https://docs.googleapis.com and https://sheets.googleapis.com.
//
// Reading a Doc as plain text is easier with driveExportFile (text/plain): the Docs
// document JSON is a deeply nested structure. Left out on purpose: the by-data-filter
// variants, developer metadata, copying a sheet between spreadsheets, batchClear.

import { JSON_BODY, arrOf, bool, get, multi, obj, p, post, put, str, type JsonObject, type OpRow } from "../_kit.js";
import { HOST } from "./_common.js";

const docsServer = HOST.docs;
const sheetsServer = HOST.sheets;

const spreadsheetId = (): JsonObject => p("spreadsheetId", "path", str("The spreadsheet id (the long id inside a docs.google.com/spreadsheets/d/<id>/ URL)"));
const range = (what: string): JsonObject => p("range", "path", str(`${what} in A1 notation, e.g. Sheet1!A1:D20, Sheet1 for the whole tab, or A1:B2 for the first tab`));
const render = (): JsonObject => p("valueRenderOption", "query", str("FORMATTED_VALUE (as shown, default), UNFORMATTED_VALUE (raw numbers) or FORMULA", { enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] }));
const input = (): JsonObject => p("valueInputOption", "query", str("USER_ENTERED parses values like typing (dates, numbers, =formulas); RAW stores the text as is", { enum: ["RAW", "USER_ENTERED"] }), true);

const VALUES = obj("The cells", {
  range: str("The range the values cover (optional; the path range wins)"),
  majorDimension: str("ROWS (default: each inner array is a row) or COLUMNS", { enum: ["ROWS", "COLUMNS"] }),
  values: arrOf("An array of rows; each row an array of cell values, e.g. [[\"Name\",\"Qty\"],[\"Apples\",3]]", arrOf("One row", {})),
}, ["values"]);

export const docsOps: OpRow[] = [
  get(
    "/v1/documents/{documentId}",
    "docsGetDocument",
    "A Google Doc as structured JSON (body.content paragraphs and runs, with character indexes you need for batchUpdate). For just the text use driveExportFile",
    [
      p("documentId", "path", str("The document id (the long id inside a docs.google.com/document/d/<id>/ URL)")),
      p("includeTabsContent", "query", bool("true returns every tab under `tabs` instead of only the first tab's body")),
      p("suggestionsViewMode", "query", str("How suggested edits show", { enum: ["DEFAULT_FOR_CURRENT_ACCESS", "SUGGESTIONS_INLINE", "PREVIEW_SUGGESTIONS_ACCEPTED", "PREVIEW_WITHOUT_SUGGESTIONS"] })),
    ],
    { server: docsServer, tags: ["docs"], keywords: ["read a google doc structure", "document indexes", "get the document"], vendor: "GET /v1/documents/{documentId}" },
  ),
  post("/v1/documents", "docsCreateDocument", "Create a new blank Google Doc with a title (fill it with docsBatchUpdate); asks the owner", [], {
    server: docsServer,
    tags: ["docs"],
    risk: "write",
    keywords: ["create a google doc", "new document"],
    vendor: "POST /v1/documents",
    body: JSON_BODY(obj("The new document", { title: str("The title") }, ["title"])),
  }),
  post(
    "/v1/documents/{documentId}:batchUpdate",
    "docsBatchUpdate",
    "Edit a Doc with a list of requests: insertText {location:{index},text}, replaceAllText {containsText:{text,matchCase},replaceText}, deleteContentRange {range:{startIndex,endIndex}}, updateTextStyle, insertTable ... (they apply in order, atomically); asks the owner",
    [p("documentId", "path", str("The document id"))],
    {
      server: docsServer,
      tags: ["docs"],
      risk: "write",
      keywords: ["edit the google doc", "add text to the document", "replace text in the doc", "write into a doc"],
      vendor: "POST /v1/documents/{documentId}:batchUpdate",
      body: JSON_BODY(
        obj(
          "The edits",
          {
            requests: arrOf("Docs Request objects, e.g. [{\"insertText\":{\"location\":{\"index\":1},\"text\":\"Hello\"}}]; index 1 is the start of the body", obj("One request: exactly one of insertText, replaceAllText, deleteContentRange, updateTextStyle, updateParagraphStyle, insertTable, insertInlineImage ...")),
            writeControl: obj("Optional {requiredRevisionId} so the edit fails if the doc changed meanwhile"),
          },
          ["requests"],
        ),
      ),
    },
  ),
];

export const sheetsOps: OpRow[] = [
  get(
    "/v4/spreadsheets/{spreadsheetId}",
    "sheetsGetSpreadsheet",
    "A spreadsheet's structure: title, sheet (tab) names, ids and sizes. Pass fields to keep it small; add includeGridData only with a narrow range",
    [
      spreadsheetId(),
      p("ranges", "query", multi("Limit to these A1 ranges (with includeGridData)")),
      p("includeGridData", "query", bool("true returns the cell data of `ranges` (large: always set ranges and fields)")),
      p("fields", "query", str("Partial response mask, e.g. properties.title,sheets.properties(sheetId,title,gridProperties)")),
    ],
    { server: sheetsServer, tags: ["sheets"], keywords: ["spreadsheet tabs", "sheet names", "what tabs are in the spreadsheet"], vendor: "GET /v4/spreadsheets/{spreadsheetId}" },
  ),
  get(
    "/v4/spreadsheets/{spreadsheetId}/values/{range}",
    "sheetsGetValues",
    "The cell values of one range as rows (an array of arrays)",
    [
      spreadsheetId(),
      range("The range to read"),
      render(),
      p("majorDimension", "query", str("ROWS (default) or COLUMNS", { enum: ["ROWS", "COLUMNS"] })),
      p("dateTimeRenderOption", "query", str("SERIAL_NUMBER or FORMATTED_STRING (default)", { enum: ["SERIAL_NUMBER", "FORMATTED_STRING"] })),
    ],
    { server: sheetsServer, tags: ["sheets"], keywords: ["read the spreadsheet", "get the cells", "read a range", "read the sheet", "what is in the spreadsheet"], vendor: "GET /v4/spreadsheets/{spreadsheetId}/values/{range}" },
  ),
  get(
    "/v4/spreadsheets/{spreadsheetId}/values:batchGet",
    "sheetsBatchGetValues",
    "The cell values of several ranges in one call",
    [spreadsheetId(), p("ranges", "query", multi("The A1 ranges to read, e.g. Sheet1!A1:C10 and Totals!A1:B5")), render(), p("majorDimension", "query", str("ROWS (default) or COLUMNS", { enum: ["ROWS", "COLUMNS"] }))],
    { server: sheetsServer, tags: ["sheets"], keywords: ["read several ranges"], vendor: "GET /v4/spreadsheets/{spreadsheetId}/values:batchGet" },
  ),

  // ── changes ──
  put(
    "/v4/spreadsheets/{spreadsheetId}/values/{range}",
    "sheetsUpdateValues",
    "Overwrite the cells of a range with the given values; asks the owner",
    [spreadsheetId(), range("The range to overwrite"), input()],
    {
      server: sheetsServer,
      tags: ["sheets"],
      risk: "write",
      keywords: ["update the spreadsheet", "write to a cell", "set cell values", "edit the sheet"],
      vendor: "PUT /v4/spreadsheets/{spreadsheetId}/values/{range}",
      body: JSON_BODY(VALUES),
    },
  ),
  post(
    "/v4/spreadsheets/{spreadsheetId}/values/{range}:append",
    "sheetsAppendValues",
    "Add rows after the last row of the table found in the range (the range names the table, e.g. Sheet1); asks the owner",
    [
      spreadsheetId(),
      range("A range inside the table to append to, e.g. Sheet1 or Sheet1!A:D"),
      input(),
      p("insertDataOption", "query", str("INSERT_ROWS adds new rows (safe); OVERWRITE writes over whatever follows", { enum: ["INSERT_ROWS", "OVERWRITE"] })),
    ],
    {
      server: sheetsServer,
      tags: ["sheets"],
      risk: "write",
      keywords: ["add a row to the spreadsheet", "append to the sheet", "log it in the spreadsheet", "add a line to the sheet"],
      vendor: "POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append",
      body: JSON_BODY(VALUES),
    },
  ),
  post(
    "/v4/spreadsheets/{spreadsheetId}/values:batchUpdate",
    "sheetsBatchUpdateValues",
    "Overwrite several ranges in one call; asks the owner",
    [spreadsheetId()],
    {
      server: sheetsServer,
      tags: ["sheets"],
      risk: "write",
      keywords: ["update several ranges"],
      vendor: "POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdate",
      body: JSON_BODY(
        obj(
          "The data",
          {
            valueInputOption: str("USER_ENTERED or RAW", { enum: ["RAW", "USER_ENTERED"] }),
            data: arrOf("One entry per range", obj("A range and its values", { range: str("A1 range"), majorDimension: str("ROWS or COLUMNS"), values: arrOf("Rows", arrOf("One row", {})) })),
          },
          ["valueInputOption", "data"],
        ),
      ),
    },
  ),
  post(
    "/v4/spreadsheets/{spreadsheetId}/values/{range}:clear",
    "sheetsClearValues",
    "Erase the values of a range (formatting stays); the owner decides",
    [spreadsheetId(), range("The range to erase")],
    { server: sheetsServer, tags: ["sheets"], risk: "destructive", keywords: ["clear the cells", "empty the range", "erase the sheet data"], vendor: "POST /v4/spreadsheets/{spreadsheetId}/values/{range}:clear" },
  ),
  post("/v4/spreadsheets", "sheetsCreateSpreadsheet", "Create a new spreadsheet; asks the owner", [], {
    server: sheetsServer,
    tags: ["sheets"],
    risk: "write",
    keywords: ["create a spreadsheet", "new google sheet"],
    vendor: "POST /v4/spreadsheets",
    body: JSON_BODY(obj("The new spreadsheet", { properties: obj("Spreadsheet properties", { title: str("The title"), locale: str("e.g. en_US"), timeZone: str("IANA zone") }), sheets: arrOf("Tabs to create", obj("A tab", { properties: obj("Tab properties", { title: str("Tab name") }) })) }), false),
  }),
  post(
    "/v4/spreadsheets/{spreadsheetId}:batchUpdate",
    "sheetsBatchUpdate",
    "Structural edits as a list of requests: addSheet, deleteSheet, updateCells, repeatCell (formatting), insertDimension, deleteDimension, sortRange, mergeCells, findReplace ... (atomic; deleteSheet and deleteDimension destroy data); asks the owner",
    [spreadsheetId()],
    {
      server: sheetsServer,
      tags: ["sheets"],
      risk: "write",
      keywords: ["add a tab to the spreadsheet", "format the sheet", "sort the sheet", "insert a column", "rename the tab", "find and replace in the sheet"],
      vendor: "POST /v4/spreadsheets/{spreadsheetId}:batchUpdate",
      body: JSON_BODY(
        obj(
          "The edits",
          { requests: arrOf("Sheets Request objects, e.g. [{\"addSheet\":{\"properties\":{\"title\":\"Q4\"}}}]", obj("One request: exactly one of addSheet, deleteSheet, updateSheetProperties, updateCells, repeatCell, insertDimension, deleteDimension, sortRange, mergeCells, findReplace ...")) },
          ["requests"],
        ),
      ),
    },
  ),
];
