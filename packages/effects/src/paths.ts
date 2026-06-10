// Effects filesystem layout — under the immortal home, beside the operator's
// goals. The ledger is the auditable record of everything Ares did to the
// world; the kill-switch flag is a single durable file that halts all commits.

import path from "node:path";
import { aresAgentHome } from "@ares/agent";

export interface EffectsPaths {
  home: string;
  effectsDir: string;
  ledgerFile: string;
  killSwitchFile: string;
}

export function effectsPaths(explicit?: string): EffectsPaths {
  const home = aresAgentHome(explicit);
  const effectsDir = path.join(home, "operator", "effects");
  return {
    home,
    effectsDir,
    ledgerFile: path.join(effectsDir, "ledger.jsonl"),
    killSwitchFile: path.join(effectsDir, "HALT"),
  };
}
