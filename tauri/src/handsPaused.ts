// Title of the chat card shown while the operator kill switch is engaged:
// "Ares's hands are paused (since 3:14 PM, reason: X)". Pure, so it is
// testable without the app.

export function handsPausedTitle(name: string, at?: string, reason?: string, now: Date = new Date()): string {
  const parts: string[] = [];
  const when = at ? new Date(at) : null;
  if (when && !Number.isNaN(when.getTime())) {
    const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const sameDay = when.toDateString() === now.toDateString();
    parts.push(`since ${sameDay ? time : `${when.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`}`);
  }
  if (reason && reason.trim()) parts.push(`reason: ${reason.trim()}`);
  return `${name}'s hands are paused${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
