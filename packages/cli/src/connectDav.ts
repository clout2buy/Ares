// Connect-hub verifiers for the open-standard connectors (core/davServices.ts):
// iCloud (CalDAV + CardDAV + IMAP/SMTP behind one app-specific password) and
// the generic caldav / carddav / imap services.
//
// The real work (login, discovery, error classification, secret scrubbing)
// lives in @ares/tools davVerify so it is unit-tested without the hub; this
// file only adapts it to the hub's verifier shape. Every verifier makes a real
// read-only login BEFORE anything is stored, and the `store` it returns is
// what lands in the encrypted vault.

import { verifyCalDav, verifyCardDav, verifyIcloud, verifyImap } from "@ares/tools";
import type { VerifyOutcome } from "./connectVerifiersLife.js";

export type DavVerify = (values: Record<string, string>, signal: AbortSignal) => Promise<VerifyOutcome>;

export const DAV_VERIFIERS: Record<string, DavVerify> = {
  icloud: (values, signal) => verifyIcloud(values, signal),
  caldav: (values) => verifyCalDav(values),
  carddav: (values) => verifyCardDav(values),
  imap: (values, signal) => verifyImap(values, signal),
};
