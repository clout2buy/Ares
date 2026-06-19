// keyVault — encrypt API keys at rest.
//
// The AES-256-GCM-under-~/.ares/.keysecret implementation now lives in
// @ares/core (credentials.ts) so tools and the CLI share ONE vault. This module
// re-exports it for the existing CLI callers (telegramConfig, uiSettings) — the
// scheme and the `.keysecret` file are identical, so values encrypted before
// this move still decrypt unchanged.

export { encryptSecret, decryptSecret } from "@ares/core";
