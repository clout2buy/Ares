// Dropbox API v2 - browse and search the owner's Dropbox, read file and folder metadata,
// get a temporary download link, see revisions and shared links. Creating folders,
// moving, copying, restoring and creating a share link ask; deleting and revoking a link
// are the owner's decision.
//
// Dropbox publishes NO OpenAPI document. The machine-readable source is the vendor's Stone
// API spec (https://github.com/dropbox/dropbox-api-spec: files.stone, sharing.stone,
// users.stone), fetched 2026-09-30; every route, argument name, default and OAuth scope
// below was copied from those files. Human reference:
// https://www.dropbox.com/developers/documentation/http/documentation (a JavaScript app,
// so it could not be fetched as text). Hence source.kind "docs".
//
// Dropbox's RPC style: every call is POST with a JSON body (a route with no arguments takes
// no body), reads included, so reads here are POSTs declared risk "read".
// Deliberately left out: upload/download (they use content.dropboxapi.com and a
// Dropbox-API-Arg header), batch routes, permanently_delete, Paper, file requests, team
// (business) endpoints.

import { JSON_BODY, arrOf, bool, definePreset, int, obj, post, str } from "./_kit.js";

const PATH_NOTE = "A path starts with / (e.g. /Documents/report.pdf); the root folder is the empty string. An id:... or ns:... value also works";

export default definePreset({
  id: "dropbox",
  label: "Dropbox",
  blurb: "Browse and search your Dropbox, read file info, get temporary download links, revisions and shared links. Creating, moving or sharing asks; deleting is your decision.",
  connect: "dropbox",
  oauth: {
    provider: "dropbox",
    scopes: ["account_info.read", "files.metadata.read", "files.content.read (temporary link, revisions)", "files.metadata.write (create folder, move, copy, delete, restore)", "sharing.read (list shared links)", "sharing.write (create or revoke a shared link)"],
  },
  baseUrl: "https://api.dropboxapi.com/2",
  verifyOperationId: "getCurrentAccount",
  ratePerMin: 60,
  keywords: ["dropbox", "files", "cloud storage", "documents folder", "shared link"],
  domain: "dropbox.com",
  source: {
    kind: "docs",
    docsUrl: "https://www.dropbox.com/developers/documentation/http/documentation",
    fetchedOn: "2026-09-30",
    note: "No OpenAPI exists; routes and arguments copied from the vendor's Stone spec at https://github.com/dropbox/dropbox-api-spec (files.stone, sharing.stone, users.stone).",
  },
  notes: {
    rateLimits: "No published per-minute figure; Dropbox answers HTTP 429 (rate_limit / too_many_requests, with a Retry-After header) and write routes can answer too_many_write_operations. Concurrent identical list_folder calls from one app for one user can also be rate limited: do not run them in parallel.",
    pagination: "Lists answer {entries, cursor, has_more}. Pass the cursor to listFolderContinue (or searchFilesContinue / listSharedLinks's cursor) until has_more is false; pass pages on the Continue operations to follow it.",
    auth: "Authorization: Bearer <Dropbox OAuth access token> (short-lived, refreshed by the connected account). Every call is a POST to api.dropboxapi.com/2 with a JSON body.",
    scopes: "account_info.read, files.metadata.read, files.content.read, files.metadata.write, sharing.read, sharing.write; a missing scope answers 401 missing_scope naming it. An app-folder app only sees its own Apps/<name> folder.",
    gotchas: [
      "The ROOT folder path is the empty string \"\", not \"/\". Other paths start with / and are case-insensitive.",
      "createSharedLink makes a link that anyone who has it can open (audience public by default unless team policy restricts it): the owner is asked first; say so. A link already existing for the file answers 409 shared_link_already_exists - use listSharedLinks.",
      "getTemporaryLink returns a plain https URL valid for four hours that needs no token: treat it like a secret and do not post it anywhere.",
      "Entries are tagged: .tag is file, folder or deleted. Size is bytes; client_modified is what the device said, server_modified is Dropbox's time.",
      "Upload and download are not exposed (they use the content.dropboxapi.com host with a Dropbox-API-Arg header); use getTemporaryLink to hand a file to a person.",
      "Errors are HTTP 409 with {error_summary, error:{.tag}} (path/not_found, path/conflict/file ...): read error_summary.",
    ],
  },
  ops: [
    // Account  (stone: users.stone get_current_account, get_space_usage)
    post("/users/get_current_account", "getCurrentAccount", "The signed-in Dropbox account: name, email, country, account type", [], {
      tags: ["users"],
      risk: "read",
      keywords: ["who am i on dropbox", "my dropbox account"],
      vendor: "POST /2/users/get_current_account",
    }),
    post("/users/get_space_usage", "getSpaceUsage", "How much storage is used and the allocation, in bytes", [], {
      tags: ["users"],
      risk: "read",
      keywords: ["how much space do I have", "dropbox storage", "am I running out of space"],
      vendor: "POST /2/users/get_space_usage",
    }),

    // Files  (stone: files.stone)
    post(
      "/files/list_folder",
      "listFolder",
      "List a folder's files and subfolders (entries, plus a cursor for listFolderContinue when has_more); the root folder is the empty string",
      [],
      {
        tags: ["files"],
        risk: "read",
        keywords: ["what's in my dropbox", "list my files", "show a folder", "files in my documents folder"],
        vendor: "POST /2/files/list_folder",
        body: JSON_BODY(
          obj("Which folder", {
            path: str(`The folder. ${PATH_NOTE}`),
            recursive: bool("true lists every subfolder too (slow on big accounts)", { default: false }),
            include_deleted: bool("true also lists deleted entries", { default: false }),
            include_mounted_folders: bool("true includes app, shared and team folders", { default: true }),
            limit: int("Approximate maximum entries per call (1 to 2000)", { minimum: 1, maximum: 2000 }),
          }, ["path"]),
        ),
      },
    ),
    post(
      "/files/list_folder/continue",
      "listFolderContinue",
      "The next page of a folder listing, given the cursor from listFolder",
      [],
      {
        tags: ["files"],
        risk: "read",
        vendor: "POST /2/files/list_folder/continue",
        body: JSON_BODY(obj("The cursor", { cursor: str("The cursor from the previous listFolder or listFolderContinue answer") }, ["cursor"])),
        paginate: { style: "token", param: "cursor", next: "cursor", more: "has_more", body: true, items: "entries" },
      },
    ),
    post(
      "/files/get_metadata",
      "getMetadata",
      "Info on one file or folder: name, size, modified times, id, rev, content hash",
      [],
      {
        tags: ["files"],
        risk: "read",
        keywords: ["file info", "when was this file modified", "how big is this file"],
        vendor: "POST /2/files/get_metadata",
        body: JSON_BODY(
          obj("Which item", {
            path: str(`The file or folder (not the root). ${PATH_NOTE}`),
            include_deleted: bool("true returns metadata of a deleted item instead of not_found", { default: false }),
            include_has_explicit_shared_members: bool("true adds whether the item has explicit sharing members", { default: false }),
          }, ["path"]),
        ),
      },
    ),
    post(
      "/files/search_v2",
      "searchFiles",
      "Search the Dropbox by name and content; each match has metadata (use filename_only for names; a cursor continues)",
      [],
      {
        tags: ["files"],
        risk: "read",
        keywords: ["find a file", "search my dropbox", "where is my file", "look for a document"],
        vendor: "POST /2/files/search_v2",
        body: JSON_BODY(
          obj("The search", {
            query: str("What to search for, up to 1000 characters"),
            options: obj("Narrow the search", {
              path: str("Only under this folder; omit to search everything"),
              max_results: int("How many matches (1 to 1000)", { default: 100, minimum: 1, maximum: 1000 }),
              filename_only: bool("true matches file names only", { default: false }),
              file_extensions: arrOf("Only these extensions, e.g. [\"pdf\",\"docx\"] (no dot)", { type: "string" }),
              file_categories: arrOf("Only these categories: image, document, pdf, spreadsheet, presentation, audio, video, folder, paper, others", { type: "string" }),
              order_by: str("Order by relevance (default) or last modified time", { enum: ["relevance", "last_modified_time"] }),
              file_status: str("active (default) or deleted", { enum: ["active", "deleted"] }),
            }),
          }, ["query"]),
        ),
      },
    ),
    post(
      "/files/search/continue_v2",
      "searchFilesContinue",
      "The next page of search results, given the cursor from searchFiles",
      [],
      {
        tags: ["files"],
        risk: "read",
        vendor: "POST /2/files/search/continue_v2",
        body: JSON_BODY(obj("The cursor", { cursor: str("The cursor from the previous search answer") }, ["cursor"])),
        paginate: { style: "token", param: "cursor", next: "cursor", more: "has_more", body: true, items: "matches" },
      },
    ),
    post(
      "/files/get_temporary_link",
      "getTemporaryLink",
      "A direct download link for a file, valid four hours and needing no login (treat it as a secret)",
      [],
      {
        tags: ["files"],
        risk: "read",
        keywords: ["download link", "give me a link to the file", "download this file"],
        vendor: "POST /2/files/get_temporary_link",
        body: JSON_BODY(obj("The file", { path: str(`The file. ${PATH_NOTE}`) }, ["path"])),
      },
    ),
    post(
      "/files/list_revisions",
      "listRevisions",
      "Earlier versions of a file: rev, size, modified time",
      [],
      {
        tags: ["files"],
        risk: "read",
        keywords: ["file history", "previous versions of a file", "older versions"],
        vendor: "POST /2/files/list_revisions",
        body: JSON_BODY(
          obj("Which file", {
            path: str(`The file. ${PATH_NOTE}`),
            mode: str("path (default) lists by path; id follows the file even if it was renamed", { enum: ["path", "id"], default: "path" }),
            limit: int("How many revisions (1 to 100)", { default: 10, minimum: 1, maximum: 100 }),
          }, ["path"]),
        ),
      },
    ),
    post(
      "/files/create_folder_v2",
      "createFolder",
      "Create a folder; asks the owner",
      [],
      {
        tags: ["files"],
        risk: "write",
        keywords: ["make a folder", "new folder in dropbox"],
        vendor: "POST /2/files/create_folder_v2",
        body: JSON_BODY(obj("The folder", { path: str("The new folder's full path, e.g. /Projects/2026"), autorename: bool("true renames on a name clash instead of failing", { default: false }) }, ["path"])),
      },
    ),
    post(
      "/files/move_v2",
      "moveItem",
      "Move or rename a file or folder; asks the owner",
      [],
      {
        tags: ["files"],
        risk: "write",
        keywords: ["move a file", "rename a file", "move to another folder"],
        vendor: "POST /2/files/move_v2",
        body: JSON_BODY(
          obj("The move", {
            from_path: str("Current path of the file or folder"),
            to_path: str("New path including the new name"),
            allow_shared_folder: bool("true allows moving a shared folder", { default: false }),
            autorename: bool("true renames on a name clash instead of failing", { default: false }),
            allow_ownership_transfer: bool("true allows a move that changes ownership", { default: false }),
          }, ["from_path", "to_path"]),
        ),
      },
    ),
    post(
      "/files/copy_v2",
      "copyItem",
      "Copy a file or folder to another path; asks the owner",
      [],
      {
        tags: ["files"],
        risk: "write",
        keywords: ["copy a file", "duplicate a file"],
        vendor: "POST /2/files/copy_v2",
        body: JSON_BODY(
          obj("The copy", {
            from_path: str("Path of the file or folder to copy"),
            to_path: str("Path of the copy including its name"),
            autorename: bool("true renames on a name clash instead of failing", { default: false }),
          }, ["from_path", "to_path"]),
        ),
      },
    ),
    post(
      "/files/restore",
      "restoreFile",
      "Restore a file to an earlier revision (from listRevisions); asks the owner",
      [],
      {
        tags: ["files"],
        risk: "write",
        keywords: ["restore a deleted file", "go back to an older version"],
        vendor: "POST /2/files/restore",
        body: JSON_BODY(obj("The restore", { path: str("Where the restored file goes (the file's path)"), rev: str("The revision id from listRevisions") }, ["path", "rev"])),
      },
    ),
    post(
      "/files/delete_v2",
      "deleteItem",
      "Delete a file or folder (it can be recovered from Dropbox's deleted files for a while); the owner decides",
      [],
      {
        tags: ["files"],
        risk: "destructive",
        keywords: ["delete a file", "remove a folder", "trash this file"],
        vendor: "POST /2/files/delete_v2",
        body: JSON_BODY(obj("What to delete", { path: str("Path of the file or folder"), parent_rev: str("Only delete if the file's rev still matches (files only)") }, ["path"])),
      },
    ),

    // Sharing  (stone: sharing.stone)
    post(
      "/sharing/list_shared_links",
      "listSharedLinks",
      "Shared links the owner created, for one path or all (cursor continues)",
      [],
      {
        tags: ["sharing"],
        risk: "read",
        keywords: ["my shared links", "what have I shared", "who can see this file", "public links"],
        vendor: "POST /2/sharing/list_shared_links",
        body: JSON_BODY(
          obj("Which links", {
            path: str("Only links to this file or folder; omit for all links"),
            cursor: str("The cursor from the previous answer to get the next page"),
            direct_only: bool("true returns only links directly to the path, not to a parent folder"),
          }),
          false,
        ),
        paginate: { style: "token", param: "cursor", next: "cursor", more: "has_more", body: true, items: "links" },
      },
    ),
    post(
      "/sharing/create_shared_link_with_settings",
      "createSharedLink",
      "Create a shareable link to a file or folder; ANYONE with the link may open it, so the owner is asked first",
      [],
      {
        tags: ["sharing"],
        risk: "write",
        keywords: ["share this file", "make a share link", "create a public link", "get a link to share"],
        vendor: "POST /2/sharing/create_shared_link_with_settings",
        body: JSON_BODY(
          obj("The link", {
            path: str(`The file or folder to share. ${PATH_NOTE}`),
            settings: obj("Link options", {
              require_password: bool("true makes the link password protected"),
              link_password: str("The password when require_password is true"),
              expires: str("Expiry as a UTC timestamp, e.g. 2026-12-31T23:59:59Z; default never"),
              audience: str("Who may open it: public, team or no_one", { enum: ["public", "team", "no_one"] }),
              access: str("viewer or editor access", { enum: ["viewer", "editor", "max"] }),
              allow_download: bool("true lets viewers download"),
            }),
          }, ["path"]),
        ),
      },
    ),
    post(
      "/sharing/revoke_shared_link",
      "revokeSharedLink",
      "Turn off a shared link so it stops working; the owner decides",
      [],
      {
        tags: ["sharing"],
        risk: "destructive",
        keywords: ["stop sharing", "revoke a link", "disable the share link"],
        vendor: "POST /2/sharing/revoke_shared_link",
        body: JSON_BODY(obj("The link", { url: str("The full shared link URL, from listSharedLinks") }, ["url"])),
      },
    ),
  ],
  recipes: [
    {
      ask: "what's in my Dropbox documents folder",
      steps: [{ op: "listFolder", body: { path: "/Documents", limit: 100 }, fields: "entries.name,entries.size,entries.server_modified", note: "the root folder is path \"\"; if has_more is true call listFolderContinue with the cursor" }],
    },
    {
      ask: "find my tax return pdf in Dropbox",
      steps: [{ op: "searchFiles", body: { query: "tax return", options: { file_extensions: ["pdf"], max_results: 10 } }, fields: "matches.metadata.metadata.path_display,matches.metadata.metadata.server_modified,matches.metadata.metadata.size" }],
    },
    {
      ask: "get me a download link for a file in Dropbox",
      steps: [
        { op: "searchFiles", body: { query: "budget", options: { filename_only: true, max_results: 5 } }, fields: "matches.metadata.metadata.path_display", note: "pick the right file" },
        { op: "getTemporaryLink", body: { path: "/Documents/budget.xlsx" }, fields: "link,metadata.name", note: "the link works for four hours with no login" },
      ],
    },
    {
      ask: "how much Dropbox space do I have left",
      steps: [{ op: "getSpaceUsage", note: "used and allocation.allocated are bytes" }],
    },
    {
      ask: "what have I shared publicly from Dropbox",
      steps: [{ op: "listSharedLinks", body: {}, fields: "links.url,links.path_lower,links.expires,links.link_permissions.effective_audience.tag" }],
    },
    {
      ask: "share my report with a link",
      steps: [{ op: "createSharedLink", body: { path: "/Documents/report.pdf", settings: { audience: "public", access: "viewer", allow_download: true } }, note: "asks the owner first; anyone with the link can open it" }],
    },
  ],
  searchChecks: [
    ["what's in my dropbox folder", "listFolder"],
    ["find a file", "searchFiles"],
    ["download link for a file", "getTemporaryLink"],
    ["how much space do I have", "getSpaceUsage"],
    ["my shared links", "listSharedLinks"],
    ["share this file", "createSharedLink"],
    ["delete a file", "deleteItem"],
  ],
});
