// Checkout — "you approve the exact total before anything is charged".
//
// Before this, an order placed through the Browser rode the same approval as
// any other click: a card reading "Browser: browser_submit — click Place
// order", with no cart, no total and no card on it. The owner approved (or
// YOLO approved for them) something they could not see.
//
// Now the agent reads the real cart off the page and calls Checkout review
// with it. The permission request's `input` IS the receipt — merchant, items,
// fees, tax, tip, total, payment method, delivery address — and the phone
// renders it as a receipt card (keyed on toolName "Checkout"); Telegram prints
// it as one. It is an OWNER decision: it reaches a human even in YOLO/auto
// modes, no "always" grant answers it, and every checkout asks afresh.
//
// Approval is recorded per session. The Browser tool refuses a click that
// looks like placing the order unless an approved, unspent review exists AND
// the page still shows the approved total — so the agent can't approve $23
// and then submit a cart that grew to $41.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";

const item = z.object({
  name: z.string().min(1).describe("Item as the page shows it."),
  quantity: z.number().int().min(1).optional(),
  price: z.string().optional().describe("Line price as shown, e.g. \"$12.49\"."),
}).strict();

const inputSchema = z.object({
  action: z.enum(["review"]).default("review").describe("review: show the owner the exact order and total, and wait for their approval."),
  merchant: z.string().min(1).describe("Who is charging, e.g. \"Chipotle via DoorDash\"."),
  items: z.array(item).min(1).max(60).describe("Every line of the cart, read from the page."),
  subtotal: z.string().optional(),
  fees: z.string().optional().describe("Delivery/service fees combined, as shown."),
  tax: z.string().optional(),
  tip: z.string().optional(),
  total: z.string().min(1).describe("The exact total the page will charge, as shown (e.g. \"$23.45\")."),
  currency: z.string().optional().describe("ISO code when not obvious from the total, e.g. \"USD\"."),
  paymentMethod: z.string().optional().describe("As the page shows it, e.g. \"Visa ••4242\" — never a full card number."),
  deliveryTo: z.string().optional().describe("Delivery address or pickup location, as shown."),
  url: z.string().optional().describe("The checkout page URL."),
}).strict();

type Input = z.infer<typeof inputSchema>;

export interface CheckoutOutput {
  approved: boolean;
  total: string;
  merchant: string;
  message: string;
}

/** How long an approved review stays good for the Browser's submit click. */
function approvalTtlMs(): number {
  const env = Number(process.env.ARES_CHECKOUT_APPROVAL_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 30 * 60_000;
}

export interface ApprovedCheckout {
  merchant: string;
  total: string;
  amount: number | null;
  approvedAt: number;
}

/** sessionId → the latest approved, not-yet-spent review. */
const approvals = new Map<string, ApprovedCheckout>();

export function recordCheckoutApproval(sessionId: string, review: { merchant: string; total: string }, now = Date.now()): ApprovedCheckout {
  const entry = { merchant: review.merchant, total: review.total, amount: parseAmount(review.total), approvedAt: now };
  approvals.set(sessionId, entry);
  return entry;
}

/** The approved review this session may still spend, or null. */
export function approvedCheckout(sessionId: string, now = Date.now()): ApprovedCheckout | null {
  const entry = approvals.get(sessionId);
  if (!entry) return null;
  if (now - entry.approvedAt > approvalTtlMs()) {
    approvals.delete(sessionId);
    return null;
  }
  return entry;
}

/** One review buys one order: the submit click that used it spends it. */
export function spendCheckoutApproval(sessionId: string): void {
  approvals.delete(sessionId);
}

/** "$1,234.50" / "1.234,50 €" / "USD 23" → 1234.5 / 1234.5 / 23. Null when no number. */
export function parseAmount(text: string): number | null {
  const match = /\d[\d.,\s]*/.exec(text);
  if (!match) return null;
  let digits = match[0].replace(/\s+/g, "").replace(/[.,]$/, "");
  const lastSep = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  if (lastSep >= 0 && digits.length - lastSep - 1 === 2) {
    digits = digits.slice(0, lastSep).replace(/[.,]/g, "") + "." + digits.slice(lastSep + 1);
  } else {
    digits = digits.replace(/[.,]/g, "");
  }
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/** Does the page text show this amount anywhere? (Tolerates $, commas, spacing.) */
export function pageShowsAmount(pageText: string, amount: number): boolean {
  for (const match of pageText.matchAll(/\d[\d.,]*/g)) {
    const value = parseAmount(match[0]);
    if (value !== null && Math.abs(value - amount) < 0.005) return true;
  }
  return false;
}

/**
 * Does a click target read like PLACING an order (the final, money-moving
 * submit) rather than moving through the shop? Built on the browser_submit
 * vocabulary (submit|checkout|buy|pay|purchase|order|confirm) but narrowed so
 * "Add to order", "Proceed to checkout" and "View cart" stay free — blocking
 * those would stop the agent before it could even SEE the total to review.
 */
export function looksLikeOrderSubmission(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  // A bare "Submit"/"Confirm" is every signup and contact form on the web; it
  // counts only alongside a money word ("Submit order", "Confirm and pay").
  if (!/\b(checkout|check out|buy|pay|purchase|order|book|booking|reserve|reservation)\b/.test(t)) return false;
  // Moving through the shop, not paying.
  if (/\b(add|remove|go|proceed|continue|view|edit|update|back|return|track|save|apply|cancel|change|see|start)\b/.test(t) && !/\b(and|&) (pay|place|buy|purchase|confirm|order)\b/.test(t)) {
    return false;
  }
  if (/\b(history|details|status|summary|help|orders)\b/.test(t)) return false;
  if (/^check ?out$/.test(t)) return false;
  return true;
}

function describeReview(input: Input): string {
  const lines = input.items.slice(0, 8).map((line) => `${line.quantity && line.quantity > 1 ? `${line.quantity}× ` : ""}${line.name}${line.price ? ` ${line.price}` : ""}`);
  const more = input.items.length > 8 ? ` +${input.items.length - 8} more` : "";
  return `Approve ${input.total} at ${input.merchant}? ${lines.join(", ")}${more}${input.paymentMethod ? ` · ${input.paymentMethod}` : ""}`;
}

export const CheckoutTool = buildTool<typeof inputSchema, CheckoutOutput>({
  name: "Checkout",
  description:
    "Get the owner's approval for the EXACT order before anything is charged. Before placing ANY order, booking or purchase " +
    "(clicking Place order / Pay / Buy now / Confirm booking), call Checkout {action:\"review\"} with the real cart read from the page: " +
    "merchant, every item (name, quantity, price), subtotal, fees, tax, tip, the exact total, the payment method as shown and where it's delivered. " +
    "The owner sees it as a receipt and approves or declines. Approved → submit exactly that order, once, and nothing more; " +
    "if the total on the page changes, review again. Declined → stop; do not place the order or look for another way.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  ownerDecisions: true,
  async checkPermissions(input) {
    return { kind: "ask", prompt: describeReview(input), suggestion: "allow_once", ownerDecision: true };
  },
  activityDescription: (input) => `Asking the owner to approve ${input.total} at ${input.merchant}`,
  async call(input: Input, ctx): Promise<ToolResult<CheckoutOutput>> {
    // Reaching call() means the owner approved THIS receipt (a denial never
    // gets here — it stops the turn).
    recordCheckoutApproval(ctx.sessionId, input);
    const message =
      `The owner approved ${input.total} at ${input.merchant}. You may now submit exactly this order — these items, this total — once, and nothing more. ` +
      "If the page shows a different total before you submit, stop and call Checkout review again.";
    return {
      output: { approved: true, total: input.total, merchant: input.merchant, message },
      display: `Approved ${input.total} at ${input.merchant}`,
    };
  },
});
