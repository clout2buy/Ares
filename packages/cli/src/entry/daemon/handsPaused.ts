// "Ares's hands are paused" — the operator kill switch as the desktop sees it.
//
// WHY: the ledger shows ONE engagement on 2026-09-09 that stayed on for 41 days
// (72 halted Browser effects, zero commits, until the owner found it on Oct 20).
// operator_status never reported the switch, so the desktop always believed it
// was off: the Background panel kept offering "Halt" (a no-op re-engage), the
// HELM toggle read "Halt operator" and could never send Resume, and the owner
// only saw the model failing after ordinary messages. Every status frame now
// carries the real state, when it was engaged and why, and the chat shows a
// card with Resume.

import { KillSwitch } from "@ares/effects";

export interface HandsPausedState {
  halted: boolean;
  haltedAt?: string;
  haltReason?: string;
}

export async function handsPausedState(killSwitchFile: string): Promise<HandsPausedState> {
  const status = await new KillSwitch(killSwitchFile).status().catch(() => null);
  if (!status) return { halted: false };
  return {
    halted: true,
    ...(status.at ? { haltedAt: status.at } : {}),
    ...(status.reason ? { haltReason: status.reason } : {}),
  };
}
