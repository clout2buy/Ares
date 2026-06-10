// Prompt-cache helpers.
//
// Providers use the stable prefix key for cache-capable backends. The
// key is derived only from the system prompt and tool schemas, so normal
// conversation turns do not break cache locality.

import { createHash } from "node:crypto";
import type { ProviderRequest } from "./queryEngine.js";

export interface PromptCacheKey {
  key: string;
  systemHash: string;
  toolsHash: string;
}

export function buildPromptCacheKey(req: Pick<ProviderRequest, "system" | "tools">): PromptCacheKey {
  const systemHash = sha256(req.system);
  const toolsHash = sha256(
    JSON.stringify(
      req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    ),
  );
  return {
    key: `ares:${systemHash.slice(0, 16)}:${toolsHash.slice(0, 16)}`,
    systemHash,
    toolsHash,
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
