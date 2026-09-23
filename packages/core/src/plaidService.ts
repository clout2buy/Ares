// "Connect my bank" — the Plaid entry in the connect registry.
//
// One card, like Muse's bank connector: the owner taps it, picks their bank
// in Plaid's own UI (Hosted Link) on their phone, and Ares gets read-only
// access. Two stages, both run by the connect hub (cli/connectPlaid.ts):
//   A  first time only: a setup form takes the owner's Plaid keys (a free
//      Trial account at dashboard.plaid.com — 10 bank connections, US/Canada)
//   B  every time: a Hosted Link session; the hub exchanges the public token
//      and stores the bank under PLAID_ITEMS in the vault
// It is an "api-key" service so every consumer of ConnectKind (the phone's
// Connections list, the connect_request card) keeps working unchanged; the
// hub routes any plaid id to its own pages.
//
// Two ids beyond "plaid" reach the same flow when a bank is already linked
// (plain "plaid" then reads as connected and the Connect tool stops early):
//   plaid:add               link another bank (uses another Trial slot)
//   plaid:update:<item_id>  update mode — the owner signs in to that bank
//                           again after ITEM_LOGIN_REQUIRED; same Item
// Neither carries `stores`, so neither ever reads as connected.

import type { ConnectService } from "./connectServices.js";

const PLAID_FIELDS: NonNullable<ConnectService["fields"]> = [
  { credential: "PLAID_CLIENT_ID", label: "client_id", placeholder: "24 characters", help: "Plaid Dashboard → Developers → Keys." },
  { credential: "PLAID_SECRET", label: "Secret", secret: true, help: "The Production secret (or the Sandbox secret, to test with fake banks)." },
];

export const PLAID_SERVICE: ConnectService = {
  id: "plaid",
  label: "Bank accounts (Plaid)",
  kind: "api-key",
  domain: "plaid.com",
  blurb:
    "Read-only balances, transactions, subscriptions, cards, loans and investments from your banks. You pick your bank in Plaid's own screen; Ares never sees your bank password. " +
    "Uses your own free Plaid Trial (10 bank connections, US/Canada — a removed connection doesn't free a slot).",
  keywords: [
    "plaid", "bank", "banking", "my bank", "bank account", "bank accounts", "bank balance", "my balance", "finances", "my finances", "balance",
    "transactions", "my transactions", "subscriptions", "my subscriptions", "spending", "my spending", "credit card", "credit cards", "loans", "my loans",
    "investments", "my investments", "checking account", "savings account", "credit card balance",
  ],
  keyUrl: "https://dashboard.plaid.com/developers/keys",
  fields: PLAID_FIELDS,
  stores: ["PLAID_ITEMS"],
  appSetup: {
    consoleUrl: "https://dashboard.plaid.com/signup",
    steps: [
      "Create a free Plaid account at dashboard.plaid.com (the Trial plan: 10 bank connections free, US/Canada).",
      "Developers → Keys: copy your client_id and the Production secret.",
      "Developers → API → Allowed redirect URIs: add the completion address shown below (harmless if Plaid doesn't ask for it).",
      "Paste them below. After this, connecting a bank is one tap.",
    ],
  },
  howToUse:
    "Use the Bank tool: accounts (balances), transactions {days, account?, query?}, spending_summary {days}, recurring (subscriptions/bills), new_charges, liabilities (cards/loans), investments (holdings), items (linked banks + Trial usage). " +
    "Read-only. Another bank: Connect \"plaid:add\". A bank that needs a fresh login: Connect \"plaid:update:<item_id>\".",
};

/** True for "plaid" and its add/update variants — the hub's routing test. */
export function isPlaidService(service: Pick<ConnectService, "id">): boolean {
  return service.id === "plaid" || service.id.startsWith("plaid:");
}

/** The item a "plaid:update:<item_id>" flow repairs, if any. */
export function plaidUpdateItemId(service: Pick<ConnectService, "id">): string | undefined {
  const m = /^plaid:update:(.+)$/.exec(service.id);
  return m ? m[1] : undefined;
}

/** "plaid:add" / "plaid:update:<item_id>" → a flow service that never reads
 *  as connected. Anything else → null. */
export function plaidVariantService(query: string): ConnectService | null {
  const q = query.trim();
  const update = /^plaid:update:([A-Za-z0-9_-]{1,128})$/.exec(q);
  if (update) {
    return { ...PLAID_SERVICE, id: `plaid:update:${update[1]}`, stores: [], keywords: [], blurb: "Sign in to your bank again in Plaid so Ares can keep reading it (same connection — no new Trial slot)." };
  }
  if (/^plaid:(add|another|new)$/i.test(q)) {
    return { ...PLAID_SERVICE, id: "plaid:add", stores: [], keywords: [], blurb: "Link another bank through Plaid (uses one of your Trial's 10 connections)." };
  }
  return null;
}
