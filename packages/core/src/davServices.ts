// Open-standard personal-data connectors: CalDAV, CardDAV and IMAP/SMTP.
//
// Apple exposes iCloud Calendar, Reminders, Contacts and Mail on these open
// protocols behind an app-specific password, which is how Ares reaches the
// owner's iPhone-synced data without any phone app being open. The very same
// three protocols serve Fastmail, Nextcloud, Radicale, Yahoo, Proton Bridge,
// Google (CalDAV) and most other providers, so one generic service per
// protocol covers the long tail.
//
// Each entry is an ordinary `api-key` ConnectService (a secure form on the
// owner's phone, nothing typed into chat); the hub verifies the login LIVE
// with a read-only discovery before storing anything (cli/connectDav.ts).
// Vault names are exported because the tools (tools/davCommon.ts) read them
// back and must agree with the forms.

import type { ConnectService } from "./connectServices.js";

export const DAV_CREDENTIALS = {
  icloud: { appleId: "ICLOUD_APPLE_ID", appPassword: "ICLOUD_APP_PASSWORD", mailAddress: "ICLOUD_MAIL_ADDRESS" },
  caldav: { url: "CALDAV_URL", user: "CALDAV_USER", password: "CALDAV_PASSWORD" },
  carddav: { url: "CARDDAV_URL", user: "CARDDAV_USER", password: "CARDDAV_PASSWORD" },
  imap: { host: "IMAP_HOST", user: "IMAP_USER", password: "IMAP_PASSWORD", smtpHost: "SMTP_HOST", from: "IMAP_FROM" },
} as const;

export const DAV_SERVICES: ConnectService[] = [
  {
    id: "icloud",
    label: "iCloud: Calendar, Reminders, Contacts, Mail",
    kind: "api-key",
    domain: "icloud.com",
    blurb:
      "Your iPhone-synced iCloud Calendar, Reminders, Contacts and Mail, reached over Apple's open CalDAV/CardDAV/IMAP servers. " +
      "It works even while your phone is off. It needs an APP-SPECIFIC password, never your Apple ID password. " +
      "Apple limits this route: Reminders and Notes you upgraded to the newer iCloud format are not exposed to third-party apps.",
    keywords: [
      "icloud", "i cloud", "apple id", "apple calendar", "apple contacts", "apple reminders", "apple mail", "apple notes",
      "iphone calendar", "iphone reminders", "iphone contacts", "icloud calendar", "icloud mail", "icloud contacts", "icloud reminders", "icloud notes",
      "me.com", "icloud.com",
    ],
    keyUrl: "https://account.apple.com/account/manage",
    formHint:
      "Create an app-specific password first: sign in at account.apple.com, open Sign-In and Security, then App-Specific Passwords, press + and name it Ares. " +
      "Apple shows it once, as xxxx-xxxx-xxxx-xxxx. Two-factor authentication must be on for your Apple ID.",
    fields: [
      { credential: DAV_CREDENTIALS.icloud.appleId, label: "Apple ID", placeholder: "you@icloud.com", help: "The email address you sign in to iCloud with." },
      { credential: DAV_CREDENTIALS.icloud.appPassword, label: "App-specific password", placeholder: "xxxx-xxxx-xxxx-xxxx", secret: true, help: "From account.apple.com, NOT your normal Apple ID password." },
      { credential: DAV_CREDENTIALS.icloud.mailAddress, label: "iCloud Mail address (optional)", placeholder: "you@icloud.com", optional: true, help: "Only if your Apple ID is not itself an @icloud.com / @me.com / @mac.com address." },
    ],
    howToUse:
      "Load these with ToolSearch: Calendar (events with recurrence, reminders), Contacts, Mail (iCloud Mail over IMAP/SMTP, plus the Notes folder read-only). " +
      "Reads are free; creating, changing or deleting anything and ALL sending asks the owner first.",
  },
  {
    id: "caldav",
    label: "CalDAV (any calendar server)",
    kind: "api-key",
    blurb: "Calendar and reminders from any CalDAV server: Fastmail, Nextcloud, Google, Radicale, Baikal, Synology and more.",
    keywords: ["caldav", "cal dav", "nextcloud", "nextcloud calendar", "fastmail calendar", "radicale", "baikal", "synology calendar"],
    keyUrl: "https://en.wikipedia.org/wiki/CalDAV",
    formHint: "Use an app password if the provider offers them. The server address can be just the site (https://dav.example.com); Ares finds the calendars itself.",
    fields: [
      { credential: DAV_CREDENTIALS.caldav.url, label: "Server address", placeholder: "https://caldav.example.com", help: "Fastmail: https://caldav.fastmail.com. Google: https://apidata.googleusercontent.com/caldav/v2/ (needs an OAuth token, so prefer the Google connection)." },
      { credential: DAV_CREDENTIALS.caldav.user, label: "Username" },
      { credential: DAV_CREDENTIALS.caldav.password, label: "Password or app password", secret: true },
    ],
    howToUse: "Use the Calendar tool (load it with ToolSearch): calendars, events with recurrence, reminders. Creating, changing or deleting asks the owner first.",
  },
  {
    id: "carddav",
    label: "CardDAV (any contacts server)",
    kind: "api-key",
    blurb: "Contacts from any CardDAV server: Fastmail, Nextcloud, Radicale, Baikal, Synology and more.",
    keywords: ["carddav", "card dav", "nextcloud contacts", "fastmail contacts", "address book"],
    keyUrl: "https://en.wikipedia.org/wiki/CardDAV",
    formHint: "Use an app password if the provider offers them. The server address can be just the site; Ares finds the address books itself.",
    fields: [
      { credential: DAV_CREDENTIALS.carddav.url, label: "Server address", placeholder: "https://carddav.example.com", help: "Fastmail: https://carddav.fastmail.com." },
      { credential: DAV_CREDENTIALS.carddav.user, label: "Username" },
      { credential: DAV_CREDENTIALS.carddav.password, label: "Password or app password", secret: true },
    ],
    howToUse: "Use the Contacts tool (load it with ToolSearch): search, get, create, update. Changing anything asks the owner first.",
  },
  {
    id: "imap",
    label: "Mail over IMAP/SMTP (any mail server)",
    kind: "api-key",
    blurb: "Read and send mail on any IMAP/SMTP account: Fastmail, Yahoo, Proton Mail Bridge, Zoho, your own server.",
    keywords: ["imap", "smtp", "imap mail", "yahoo mail", "yahoo", "proton bridge", "protonmail", "proton mail", "fastmail", "zoho mail", "mail server"],
    keyUrl: "https://en.wikipedia.org/wiki/Internet_Message_Access_Protocol",
    formHint:
      "Use an app password where the provider requires one (Yahoo, Fastmail, Gmail with 2-step on). " +
      "The mail server is the IMAP host, for example imap.mail.yahoo.com or 127.0.0.1:1143 for Proton Bridge.",
    fields: [
      { credential: DAV_CREDENTIALS.imap.host, label: "IMAP server", placeholder: "imap.example.com (or host:port)", help: "Port 993 (TLS) is assumed when none is given." },
      { credential: DAV_CREDENTIALS.imap.user, label: "Username", help: "Usually your full email address." },
      { credential: DAV_CREDENTIALS.imap.password, label: "Password or app password", secret: true },
      { credential: DAV_CREDENTIALS.imap.smtpHost, label: "SMTP server (optional)", placeholder: "smtp.example.com (or host:port)", optional: true, help: "Left blank, Ares uses smtp. in place of imap. on the same domain, port 587 with STARTTLS." },
      { credential: DAV_CREDENTIALS.imap.from, label: "Send-as address (optional)", placeholder: "you@example.com", optional: true, help: "Only if your username is not your email address." },
    ],
    howToUse: "Use the Mail tool (load it with ToolSearch): folders, search, read, move, flag; send and reply ALWAYS ask the owner first, showing the exact text.",
  },
];
