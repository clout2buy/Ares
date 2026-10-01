// Policy categories for the universal connectors (Api, Mqtt, Hooks) — the half
// that makes their asks STICK on the phone and in the unattended loop (see
// policyGateLife.ts for why: remoteAutonomyDecision only escalates what
// classifies into a gated category).
//
//   Api   GET/HEAD/OPTIONS and declared read-only POSTs  → nothing (they run)
//         any other method                               → browser_submit
//         financial-looking operation or service call    → payment_or_purchase
//         DELETE / destructive-looking operation         → shell_destructive
//         a message / post / comment (preset risk)       → email_send (words in front of others)
//         add / remove / refresh a service               → credential_or_secret
//                                                          (it changes what Ares may reach)
//   Mqtt  publish                                        → browser_submit
//   Hooks create / delete                                → credential_or_secret
//                                                          (opens or closes a door to the internet)
// `undefined` means "not one of these tools" so the caller carries on.

import type { ActionCategory } from "@ares/effects";
import { classifyApiCall } from "@ares/tools";

export function universalToolCategory(toolName: string, input: unknown): ActionCategory | null | undefined {
  const rec = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) as Record<string, unknown>;
  const action = typeof rec.action === "string" ? rec.action : "";
  switch (toolName) {
    case "Api": {
      if (action === "add" || action === "remove" || action === "refresh") return "credential_or_secret";
      if (action !== "call") return null;
      const opId = String(rec.operationId ?? rec.operation_id ?? "");
      const params = rec.params && typeof rec.params === "object" ? (rec.params as Record<string, unknown>) : undefined;
      const cls = classifyApiCall(String(rec.service ?? "").toLowerCase(), opId, params, undefined, rec.body);
      if (cls.kind !== "write") return null;
      if (cls.financial) return "payment_or_purchase";
      if (cls.destructive) return "shell_destructive";
      if (cls.message) return "email_send";
      return "browser_submit";
    }
    case "Mqtt":
      return action === "publish" ? "browser_submit" : null;
    case "Hooks":
      return action === "create" || action === "delete" ? "credential_or_secret" : null;
    default:
      return undefined;
  }
}
