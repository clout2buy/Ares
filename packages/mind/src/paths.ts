// Where the mind lives. Default is under the immortal home, but the memory
// root is PLUGGABLE — point it at a flashdrive and Crix just lives there
// ("make this your home"). That's the whole portability story: one path.
//
// Mind is the foundational layer, so it owns its own home resolution and depends
// on nothing above it. `crixHome` MUST resolve identically to the agent/operator
// home so the whole entity shares one ~/.crix.

import os from "node:os";
import path from "node:path";

export interface MindPaths {
  home: string;
  mindDir: string;
  memoryFile: string;
}

/** Resolve Crix's immortal home (`$CRIX_HOME` or ~/.crix). */
export function crixHome(explicit?: string): string {
  return path.resolve(explicit ?? process.env.CRIX_HOME ?? path.join(os.homedir(), ".crix"));
}

export function mindPaths(explicit?: string): MindPaths {
  const home = crixHome(explicit);
  const mindDir = path.join(home, "mind");
  return { home, mindDir, memoryFile: path.join(mindDir, "memory.jsonl") };
}
