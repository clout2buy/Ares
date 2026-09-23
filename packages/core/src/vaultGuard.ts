// The vault guard — the model's shell must not be a skeleton key.
//
// Ares runs its shell as the same OS user that owns the credential vault, so
// file permissions are no wall: `cat ~/.ares/credentials.json`, a `node -e`
// that imports getCredential, or a tar of the whole home would hand every key
// the owner stored to whatever the model decided to do next. Encryption at
// rest does not help either — the machine secret (.keysecret) sits beside it.
//
// This classifier recognises shell commands that READ the secret store —
// the vault, its key, OAuth token files, browser sessions/profiles, the
// garrison token, the Apple signing material — or that load the credential
// API from a script. A match is escalated to the owner (never auto-approved,
// denied outright when no owner is present). It is deliberately narrow:
// ordinary work in ~/.ares (CAPABILITIES.md, memory/*.md, logs) must keep
// flowing, so only the named secret locations match, plus whole-home reads
// that would sweep them up (a tar/cp/grep -r of ~/.ares itself).
//
// PURE — string analysis only, no filesystem access.

import os from "node:os";
import path from "node:path";

/** Things under the Ares home that are secrets, as path-regex fragments. */
const SECRET_UNDER_HOME = [
  "credentials\\.json",
  "\\.keysecret",
  "auth\\.json",
  "[\\w.-]*-auth\\.json",
  "anthropic-oauth\\.json[\\w.-]*",
  "ui\\.json",
  "garrison/+token(?:-read)?\\b",
  "asc(?:/|\\b)",
  "browser-sessions\\b",
  "browser-profile\\b",
  "vault(?:/|\\b)",
  "mcp-clients\\.json",
];

/** Names specific enough to be the vault wherever they appear. */
const SECRET_ANYWHERE = [
  /(?:^|[\s'"=/])\.keysecret\b/,
  /\banthropic-oauth\.json/,
  /\bkimi-auth\.json/,
  /\bares-browser-profile\b/,
  /\bbrowser-sessions\//,
];

/** Credential API names — only meaningful inside a script being run. */
const CREDENTIAL_API = /\b(?:getCredential|decryptSecret|loadTokens|getValidAccessToken|redeemSecretHandle|listCredentialNames|decryptWithKeyFile)\b/;
/** The command runs code: an interpreter eval/heredoc or an import of @ares/core. */
const RUNS_SCRIPT = /(?:\b(?:node|nodejs|tsx|ts-node|bun|deno|npx)\b[^|;&]*(?:\s-(?:e|p)\b|\s--eval\b|\s--print\b|<<)|\bpython[\d.]*\b[^|;&]*(?:\s-c\b|<<)|@ares\/core|require\s*\(|\bimport\s*\(|\bimport\s*\{)/i;

/** Commands that copy, dump or search file CONTENT (vs. list names). */
const CONTENT_READERS = /\b(?:cat|tac|less|more|head|tail|strings|xxd|od|hexdump|base64|cp|scp|rsync|tar|zip|7z|gzip|bzip2|xz|grep|egrep|rg|ag|ack|sqlite3|jq|awk|sed|openssl|curl|nc|python[\d.]*|node|Get-Content|Copy-Item|Compress-Archive|Select-String)\b/i;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every way a command can name the Ares home, as regex alternatives. */
function homeRefs(home?: string): string {
  const resolved = (home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares")).replace(/\\/g, "/").replace(/\/+$/, "");
  const refs = new Set<string>([
    escapeRegex(resolved),
    "~/\\.ares",
    "\\$\\{?HOME\\}?/\\.ares",
    "\\$\\{?ARES_HOME\\}?",
    "%USERPROFILE%/\\.ares",
    "\\$env:USERPROFILE/\\.ares",
    "\\$env:ARES_HOME",
    // Any other absolute spelling (/home/<user>/.ares, C:/Users/<u>/.ares).
    "(?:[A-Za-z]:)?/[^\\s'\"]*?/\\.ares",
  ]);
  return [...refs].join("|");
}

/**
 * Why this command reaches into the secret store, or null when it doesn't.
 * `home` defaults to ARES_HOME / ~/.ares.
 */
export function vaultAccessReason(rawCommand: string, home?: string): string | null {
  if (!rawCommand) return null;
  const cmd = rawCommand.replace(/\\/g, "/").replace(/\s+/g, " ").trim();
  const refs = homeRefs(home);

  const underHome = new RegExp(`(?:${refs})/+(?:${SECRET_UNDER_HOME.join("|")})`, "i");
  const hit = underHome.exec(cmd);
  if (hit) return `reads Ares's secret store (${hit[0]})`;

  // `cd ~/.ares && cat credentials.json` — the home named once, the secret
  // relative to it.
  const namesHome = new RegExp(`(?:${refs})`, "i").test(cmd) || /(?:^|[\s'"/])\.ares(?:\/|\b)/.test(cmd);
  if (namesHome) {
    const relative = new RegExp(`(?:^|[\\s'"=])(?:\\./)?(?:${SECRET_UNDER_HOME.join("|")})`, "i").exec(cmd);
    if (relative) return `reads Ares's secret store (${relative[0].trim()})`;
  }

  for (const re of SECRET_ANYWHERE) {
    const m = re.exec(cmd);
    if (m) return `reads Ares's secret store (${m[0].trim()})`;
  }

  // The whole home (or a glob over it) fed to something that reads content:
  // `tar czf x.tgz ~/.ares`, `cp -r ~/.ares /tmp`, `grep -r sk- ~/.ares`,
  // `cat ~/.ares/*`. Naming a subdirectory (memory/, logs/) is not the home,
  // and the reader must be in the same pipeline segment: `ls ~/.ares | grep x`
  // only lists names.
  // A bare `.ares` argument counts too (`tar -C ~ .ares`); in a repo that is
  // the workspace's own .ares, and an archive of it asking once is fine.
  const wholeHome = new RegExp(`(?:${refs}|(?:^|(?<=[\\s'"]))\\.ares)(?:/+(?:\\.|[^\\s'";|&/]*\\*[^\\s'";|&/]*)?)?(?=$|[\\s'";|&)])`, "i");
  for (const segment of cmd.split(/\|\|?|;|&&/)) {
    if (wholeHome.test(segment) && CONTENT_READERS.test(segment)) {
      return "reads the whole Ares home, which holds the credential vault";
    }
  }

  if (CREDENTIAL_API.test(cmd) && RUNS_SCRIPT.test(cmd)) {
    const name = CREDENTIAL_API.exec(cmd)?.[0] ?? "credential API";
    return `runs a script that calls the credential vault (${name})`;
  }
  return null;
}

/** The owner-facing prompt for a vault-reading command. */
export function vaultAccessPrompt(reason: string): string {
  return `This command ${reason}. Secrets never go to the model; only the owner can allow this, once.`;
}
