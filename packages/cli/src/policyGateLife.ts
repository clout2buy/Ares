// Policy categories for the "life" connector tools (Hue, Tesla, Tickets,
// FlightStatus, FlightBooking, Withings, Tailscale, Bank).
//
// Each of those tools asks the owner itself (checkPermissions) for its risky
// actions; this is the half that makes the ask STICK on the phone and in the
// unattended loop — remoteAutonomyDecision only escalates what classifies into
// a gated category, and the operator loop denies anything gated outright.
//   FlightBooking book                  → payment_or_purchase (spends money)
//   Tesla unlock/remote_start/trunk/
//         frunk/honk/flash              → browser_submit (a real-world act,
//                                         the category GoogleCalendar writes use)
//   Tailscale authorize/deauthorize/
//         expire/key_expiry             → credential_or_secret (who may join
//                                         the owner's private network)
//   Bank remove_item                    → credential_or_secret (revokes a
//                                         linked bank)
// Reads, lights, climate and charging classify as nothing and just run.
// `undefined` means "not one of these tools" so the caller carries on.

import type { ActionCategory } from "@ares/effects";

const TESLA_ASK = new Set(["unlock", "remote_start", "trunk", "frunk", "honk", "flash"]);
const TAILSCALE_ASK = new Set(["authorize", "deauthorize", "expire", "key_expiry"]);
const READ_ONLY = new Set(["Hue", "Tickets", "FlightStatus", "Withings"]);

export function lifeToolCategory(toolName: string, action: string): ActionCategory | null | undefined {
  switch (toolName) {
    case "FlightBooking":
      return action === "book" ? "payment_or_purchase" : null;
    case "Tesla":
      return TESLA_ASK.has(action) ? "browser_submit" : null;
    case "Tailscale":
      return TAILSCALE_ASK.has(action) ? "credential_or_secret" : null;
    case "Bank":
      // Disconnecting a bank revokes a credential (and, on Plaid's Trial, the
      // slot is gone for good).
      return action === "remove_item" ? "credential_or_secret" : null;
    default:
      return READ_ONLY.has(toolName) ? null : undefined;
  }
}
