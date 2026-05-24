import type { ToolDefinition } from "@crix/protocol";

export type ToolConcurrency = ToolDefinition["concurrency"];

export interface ScheduledToolCall<TCall> {
  call: TCall;
  index: number;
}

export type ToolConcurrencyResolver<TCall> = (call: TCall) => ToolConcurrency;

export function toolConcurrencyByName(
  tools: ToolDefinition[],
  fallback: ToolConcurrency = "exclusive",
): (name: string) => ToolConcurrency {
  const byName = new Map(tools.map((tool) => [tool.name, tool.concurrency] as const));
  return (name: string) => byName.get(name) ?? fallback;
}

export async function runScheduledToolCalls<TCall, TResult>(
  calls: TCall[],
  concurrencyOf: ToolConcurrencyResolver<TCall>,
  run: (call: TCall) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(calls.length);
  let index = 0;

  while (index < calls.length) {
    const current = calls[index]!;
    if (concurrencyOf(current) !== "parallel-safe") {
      results[index] = await run(current);
      index += 1;
      continue;
    }

    const batch: Array<ScheduledToolCall<TCall>> = [];
    while (index < calls.length && concurrencyOf(calls[index]!) === "parallel-safe") {
      batch.push({ call: calls[index]!, index });
      index += 1;
    }

    await Promise.all(batch.map(async (item) => {
      results[item.index] = await run(item.call);
    }));
  }

  return results;
}
