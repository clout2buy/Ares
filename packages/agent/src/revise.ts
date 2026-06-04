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

