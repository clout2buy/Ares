import type { ReflectionResult, ReflectionSurface } from "@ares/mind";

export interface ReviseSignal {
  shouldRevise: boolean;
  reason: string;
}

export function beforeAgentFinalizeSignal(events: readonly { type: string; error?: string; text?: string }[]): ReviseSignal {
  const toolErrors = events.filter((event) => event.type === "tool_error");
  if (toolErrors.length > 0) {
    return {
      shouldRevise: true,
      reason: `${toolErrors.length} tool error(s) happened before final answer; inspect failures before finalizing.`,
    };
  }
  const ruleConflict = events.find((event) => event.type === "system_reminder_injected" && /rule|conflict|undo/i.test(event.text ?? ""));
  if (ruleConflict) {
    return { shouldRevise: true, reason: "A reminder indicates a rule conflict or undo before final answer." };
  }
  return { shouldRevise: false, reason: "No self-revision trigger." };
}

/** This advisory pass as a {@link ReflectionSurface}: same signal, uniform envelope.
 *  It only advises (persists nothing), so persistedTo is always absent. */
export const reviseReflectionSurface: ReflectionSurface<
  readonly { type: string; error?: string; text?: string }[]
> = {
  name: "revise-signal",
  run(events): ReflectionResult {
    const signal = beforeAgentFinalizeSignal(events);
    return { directives: signal.shouldRevise ? [signal.reason] : [] };
  },
};

