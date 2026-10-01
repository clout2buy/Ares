// Google People API v1 (contacts) operations of the Google preset. Curated from the
// discovery document https://people.googleapis.com/$discovery/rest?version=v1 (fetched
// 2026-09-30). Host https://people.googleapis.com.
//
// Resource names look like people/c123456789 (a contact) or people/me (the owner); they
// contain a slash, so that path parameter is declared reserved. personFields / readMask
// are REQUIRED field masks (names,emailAddresses,phoneNumbers,...).
//
// Left out on purpose: batch create/update/delete, contact photos, directory listing
// (Workspace only), contact-group edits.

import { JSON_BODY, arrOf, del, get, int, obj, p, patch, post, str, type JsonObject, type OpRow } from "../_kit.js";
import { HOST, pageToken } from "./_common.js";

const server = HOST.people;

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,birthdays,addresses,biographies,urls,photos,memberships";
const mask = (name: string, required = true): JsonObject =>
  p(name, "query", str(`Comma list of fields to return: any of ${PERSON_FIELDS}`), required);
const resource = (what: string): JsonObject => p("resourceName", "path", str(what), true, { "x-reserved": true });

const PERSON = {
  names: arrOf("Names", obj("A name", { givenName: str("First name"), familyName: str("Last name") })),
  emailAddresses: arrOf("Emails", obj("An email", { value: str("The address"), type: str("home, work or other") })),
  phoneNumbers: arrOf("Phones", obj("A phone", { value: str("The number"), type: str("mobile, home, work or other") })),
  organizations: arrOf("Employers", obj("An employer", { name: str("Company"), title: str("Job title") })),
  biographies: arrOf("Notes", obj("A note", { value: str("The text"), contentType: str("TEXT_PLAIN") })),
} as Record<string, JsonObject>;

export const peopleOps: OpRow[] = [
  get(
    "/v1/people/me",
    "peopleGetMe",
    "The owner's own Google profile: name, email addresses, photo",
    [mask("personFields")],
    { server, tags: ["people", "account"], keywords: ["my google profile", "my name and email", "who am I"], vendor: "GET /v1/{resourceName}" },
  ),
  get(
    "/v1/{resourceName}",
    "peopleGetPerson",
    "One contact (or profile) by resource name, e.g. people/c1234567890",
    [resource("The contact's resource name from a search or list, e.g. people/c1234567890"), mask("personFields")],
    { server, tags: ["people", "contacts"], keywords: ["contact details", "get this contact"], vendor: "GET /v1/{resourceName}" },
  ),
  get(
    "/v1/people/me/connections",
    "peopleListConnections",
    "The owner's contacts (My Contacts), newest changed or alphabetical",
    [
      mask("personFields"),
      p("pageSize", "query", int("How many (default 100, max 1000)")),
      p("sortOrder", "query", str("LAST_MODIFIED_DESCENDING, LAST_MODIFIED_ASCENDING, FIRST_NAME_ASCENDING or LAST_NAME_ASCENDING", { enum: ["LAST_MODIFIED_DESCENDING", "LAST_MODIFIED_ASCENDING", "FIRST_NAME_ASCENDING", "LAST_NAME_ASCENDING"] })),
      pageToken(),
    ],
    {
      server,
      tags: ["people", "contacts"],
      keywords: ["my contacts", "list my contacts", "address book", "everyone in my contacts"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "connections", limitParam: "pageSize" },
      vendor: "GET /v1/{resourceName}/connections",
    },
  ),
  get(
    "/v1/people:searchContacts",
    "peopleSearchContacts",
    "Find contacts by name, email, phone or company (prefix match); the cache can lag a minute behind new contacts, so warm it with an empty query once",
    [p("query", "query", str("Words to match: a name, an email or a phone number"), true), p("readMask", "query", str(`Fields to return: any of ${PERSON_FIELDS}`), true), p("pageSize", "query", int("How many (default 10, max 30)"))],
    { server, tags: ["people", "contacts"], keywords: ["find a contact", "phone number of", "email address of", "look up a contact", "what is her number"], vendor: "GET /v1/people:searchContacts" },
  ),
  get(
    "/v1/people:batchGet",
    "peopleBatchGetPeople",
    "Several contacts by resource name in one call",
    [p("resourceNames", "query", { type: "array", items: { type: "string" }, description: "Resource names, e.g. people/c1 and people/c2", "x-explode": true }, true), mask("personFields")],
    { server, tags: ["people", "contacts"], vendor: "GET /v1/people:batchGet" },
  ),
  get("/v1/contactGroups", "peopleListContactGroups", "The owner's contact groups (labels): name, member count, resource name", [p("pageSize", "query", int("How many (default 30, max 1000)")), pageToken()], {
    server,
    tags: ["people", "contacts"],
    keywords: ["my contact groups", "contact labels"],
    paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "contactGroups", limitParam: "pageSize" },
    vendor: "GET /v1/contactGroups",
  }),
  get(
    "/v1/otherContacts",
    "peopleListOtherContacts",
    "People the owner has emailed but not saved as contacts (names and emails only)",
    [p("readMask", "query", str("Fields to return: emailAddresses, names, phoneNumbers"), true), p("pageSize", "query", int("How many (default 100, max 1000)")), pageToken()],
    {
      server,
      tags: ["people", "contacts"],
      keywords: ["people I have emailed", "other contacts"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "otherContacts", limitParam: "pageSize" },
      vendor: "GET /v1/otherContacts",
    },
  ),
  get(
    "/v1/otherContacts:search",
    "peopleSearchOtherContacts",
    "Search the 'other contacts' (people only emailed) by name or email",
    [p("query", "query", str("Words to match"), true), p("readMask", "query", str("Fields to return: emailAddresses, names, phoneNumbers"), true), p("pageSize", "query", int("How many (default 10, max 30)"))],
    { server, tags: ["people", "contacts"], keywords: ["find someone I emailed"], vendor: "GET /v1/otherContacts:search" },
  ),

  // ── changes ──
  post("/v1/people:createContact", "peopleCreateContact", "Create a contact; asks the owner", [mask("personFields", false)], {
    server,
    tags: ["people", "contacts"],
    risk: "write",
    keywords: ["add a contact", "save a contact", "new contact"],
    vendor: "POST /v1/people:createContact",
    body: JSON_BODY(obj("The contact", PERSON)),
  }),
  patch(
    "/v1/{resourceName}:updateContact",
    "peopleUpdateContact",
    "Change a contact; updatePersonFields names which parts of the body to apply, and the body must carry the contact's current etag; asks the owner",
    [resource("The contact's resource name, e.g. people/c1234567890"), p("updatePersonFields", "query", str("Comma list of the fields being changed, e.g. phoneNumbers,emailAddresses"), true)],
    {
      server,
      tags: ["people", "contacts"],
      risk: "write",
      keywords: ["update a contact", "change her phone number", "edit the contact"],
      vendor: "PATCH /v1/{resourceName}:updateContact",
      body: JSON_BODY(obj("The new values plus the current etag", { etag: str("The contact's etag from peopleGetPerson (required)"), ...PERSON }, ["etag"])),
    },
  ),
  del("/v1/{resourceName}:deleteContact", "peopleDeleteContact", "Delete a contact; the owner decides", [resource("The contact's resource name, e.g. people/c1234567890")], {
    server,
    tags: ["people", "contacts"],
    keywords: ["delete the contact", "remove a contact"],
    vendor: "DELETE /v1/{resourceName}:deleteContact",
  }),
];
