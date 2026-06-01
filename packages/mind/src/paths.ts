// Where the mind lives. Default is under the immortal home, but the memory
// root is PLUGGABLE — point it at a flashdrive and Crix just lives there
// ("make this your home"). That's the whole portability story: one path.

import path from "node:path";
import { crixAgentHome } from "@crix/agent";

export interface MindPaths {
  home: string;
  mindDir: string;
  memoryFile: string;
}

export function mindPaths(explicit?: string): MindPaths {
  const home = crixAgentHome(explicit);
  const mindDir = path.join(home, "mind");
  return { home, mindDir, memoryFile: path.join(mindDir, "memory.jsonl") };
}
