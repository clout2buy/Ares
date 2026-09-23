// Permission prompts and connector cards — the two things Ares interrupts you
// for. Pure helpers so the bridge's plumbing stays thin and testable.
//
// Three defects this module exists to fix:
//   1. A prompt showed the tool NAME and a generic reason, never the actual
//      command/path/URL. You cannot judge "Bash" — so you tap Always and stop
//      reading. Now every prompt carries one line of the real input.
//   2. Identical requests each sent their own message. A retrying tool could
//      paper the chat with the same question. Now they collapse onto one
//      prompt keyed by tool + input, answered once for all of them.
//   3. A tool needing an unconnected service failed with an opaque
//      OAUTH_NOT_AUTHORIZED the owner never saw. Now the bridge recognizes it
//      and offers the sign-in right there, at the point of need.

/** Input fields worth showing, in the order we'd want to read them. */
const DETAIL_KEYS = [
  "command",
  "url",
  "file_path",
  "path",
  "pattern",
  "to",
  "recipient",
  "query",
  "provider",
  "text",
  "action",
] as const;

const MAX_DETAIL_CHARS = 180;

function flatten(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(flatten).filter((p): p is string => p !== undefined);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

/**
 * One human line describing what a tool is actually about to do, pulled from
 * its input. Returns undefined when nothing recognizable is there — better no
 * line than a dump of JSON on a phone.
 */
export function describePermissionInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return flatten(input)?.slice(0, MAX_DETAIL_CHARS);
  const record = input as Record<string, unknown>;
  const receipt = describeReceipt(record);
  if (receipt) return receipt;
  for (const key of DETAIL_KEYS) {
    const shown = flatten(record[key]);
    if (shown === undefined) continue;
    const clipped = shown.replace(/\s+/g, " ").trim();
    return clipped.length > MAX_DETAIL_CHARS ? `${clipped.slice(0, MAX_DETAIL_CHARS - 1)}…` : clipped;
  }
  return undefined;
}

const MAX_RECEIPT_LINES = 10;

/**
 * A Checkout review is a receipt, not one line: the owner is approving an
 * exact total, so they must see what it buys. Merchant, each item, the money
 * lines, and the total last and bold-ish (on its own line). Undefined for any
 * input that isn't a receipt shape.
 */
export function describeReceipt(record: Record<string, unknown>): string | undefined {
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined);
  const merchant = str(record.merchant);
  const total = str(record.total);
  if (!merchant || !total || !Array.isArray(record.items)) return undefined;
  const lines = [`🧾 ${merchant}`];
  const items = record.items.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
  for (const item of items.slice(0, MAX_RECEIPT_LINES)) {
    const name = str(item.name) ?? "item";
    const quantity = typeof item.quantity === "number" && item.quantity > 1 ? `${item.quantity}× ` : "";
    const price = str(item.price);
    lines.push(`• ${quantity}${name}${price ? ` — ${price}` : ""}`);
  }
  if (items.length > MAX_RECEIPT_LINES) lines.push(`• …and ${items.length - MAX_RECEIPT_LINES} more`);
  for (const [key, label] of [["subtotal", "Subtotal"], ["fees", "Fees"], ["tax", "Tax"], ["tip", "Tip"]] as const) {
    const value = str(record[key]);
    if (value) lines.push(`${label}: ${value}`);
  }
  const currency = str(record.currency);
  lines.push(`TOTAL: ${total}${currency && !total.includes(currency) ? ` ${currency}` : ""}`);
  const payment = str(record.paymentMethod);
  if (payment) lines.push(`Paying with ${payment}`);
  const deliver = str(record.deliveryTo);
  if (deliver) lines.push(`To: ${deliver}`);
  return lines.join("\n");
}

/**
 * Identity of a permission question: same session, same tool, same input is the
 * same question, however many times the model asks it. Inputs are serialized
 * with sorted keys so key order can't split one question into two prompts, and
 * the fields that only explain WHY (a Bash `description`, a `reason`) are left
 * out — rewording the justification does not make it a new question. Mirrors
 * the garrison's canonicalActionKey (ownerGuards.ts), which refuses a repeat
 * of a denied action; the two must agree or a refused repeat posts a card.
 */
const COSMETIC_INPUT_KEYS = new Set(["description", "reason", "explanation", "justification", "rationale", "why"]);

export function permissionKey(sessionId: string, toolName: string, input: unknown): string {
  const identity =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) => !COSMETIC_INPUT_KEYS.has(key)))
      : input;
  return `${sessionId}|${toolName}|${stableStringify(identity).slice(0, 500)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function renderPermissionPrompt(opts: { toolName: string; reason?: string; detail?: string }): string {
  const lines = ["🛡 Permission needed", opts.toolName];
  if (opts.detail) lines.push(`↳ ${opts.detail}`);
  if (opts.reason && opts.reason.trim()) lines.push(opts.reason.trim());
  // A checkout is approved one receipt at a time — "Always" can't pre-approve the next one.
  lines.push(opts.toolName === "Checkout" ? "Allow = pay this exact total, once. Auto-denies in 5 min." : "Always = stop asking for this tool. Auto-denies in 5 min.");
  return lines.join("\n");
}

/** What a prompt becomes once it has been answered: a closed record, no buttons. */
export function renderPermissionOutcome(
  decision: "allow_once" | "allow_always" | "deny",
  opts: { toolName: string; detail?: string },
): string {
  const head =
    decision === "deny"
      ? `🚫 Denied · ${opts.toolName}`
      : decision === "allow_always"
        ? `✅ Always allowed · ${opts.toolName}`
        : `✅ Allowed · ${opts.toolName}`;
  return opts.detail ? `${head}\n↳ ${opts.detail}` : head;
}

/** `OAUTH_NOT_AUTHORIZED: google is not connected…` → the provider to offer. */
const OAUTH_ERROR = /OAUTH_(NOT_AUTHORIZED|EXPIRED):\s*([a-z0-9_.-]+)/i;

/** String-valued result fields a tool would put such a message in. Checked by
 *  name rather than serializing the whole result: this runs on every tool_end,
 *  and a Read of a large file must not be stringified just to pattern-match. */
const MESSAGE_KEYS = ["message", "error", "detail", "reason", "output", "display", "text"] as const;

export function oauthProviderFromError(source: unknown): { provider: string; expired: boolean } | undefined {
  const candidates: string[] = [];
  if (typeof source === "string") candidates.push(source);
  else if (source instanceof Error) candidates.push(source.message);
  else if (source !== null && typeof source === "object") {
    const record = source as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      const value = record[key];
      if (typeof value === "string") candidates.push(value);
    }
  }
  for (const candidate of candidates) {
    // Bounded: the marker is at the head of the message, never buried in a dump.
    const match = OAUTH_ERROR.exec(candidate.slice(0, 2_000));
    if (match) return { provider: match[2].toLowerCase(), expired: match[1].toUpperCase() === "EXPIRED" };
  }
  return undefined;
}

/** The card offered the moment a tool trips over an unconnected service. */
export function renderConnectOffer(label: string, expired: boolean): string {
  return expired
    ? `🔗 ${label} needs re-authorizing — its access expired, which is why that just failed.`
    : `🔗 ${label} isn't connected yet — that's why that just failed.`;
}
