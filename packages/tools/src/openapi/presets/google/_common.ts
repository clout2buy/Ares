// Shared pieces of the Google preset: the hosts of the eight APIs and the few
// parameters nearly every list operation carries. Nothing here performs I/O.
//
// Google serves each API from its own host. The preset's base URL is
// https://www.googleapis.com (Calendar and Drive live there); the others are named per
// operation with `server:` and the kit adds them to the allowed origins.

import { p, str, type JsonObject } from "../_kit.js";

export const HOST = {
  gmail: "https://gmail.googleapis.com",
  docs: "https://docs.googleapis.com",
  sheets: "https://sheets.googleapis.com",
  tasks: "https://tasks.googleapis.com",
  youtube: "https://youtube.googleapis.com",
  people: "https://people.googleapis.com",
} as const;

/** Google's partial-response mask: the single best way to keep an answer small. Every list/get takes it. */
export const fields = (hint: string): JsonObject => p("fields", "query", str(`Partial response mask, e.g. ${hint}. Cuts the answer to just those fields (include nextPageToken when paging).`));

export const pageToken = (): JsonObject => p("pageToken", "query", str("The nextPageToken of the previous page"));
