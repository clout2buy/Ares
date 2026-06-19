// Stripe — create a real payment link the owner can sell through.
//
// Money capability: builds a product + price + payment link via the Stripe REST
// API (one call each), returns the shareable checkout URL. Reads the secret key
// from STRIPE_SECRET_KEY (use an sk_test_… key to stay in test mode). Always
// asks the owner first — this moves money.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    name: z.string().min(1).describe("Product name shown at checkout, e.g. 'Meal-prep waitlist deposit'."),
    amount: z.number().int().positive().describe("Price in the smallest currency unit (cents). $9.99 = 999."),
    currency: z.string().length(3).default("usd").describe("ISO currency, e.g. usd, eur."),
    quantity_adjustable: z.boolean().default(false).describe("Let the buyer change quantity at checkout."),
    description: z.string().optional().describe("Optional product description."),
  })
  .strict();

export interface StripeOutput {
  url: string;
  paymentLinkId: string;
  productId: string;
  priceId: string;
  livemode: boolean;
}

const STRIPE_API = "https://api.stripe.com/v1";

export const StripeTool = buildTool({
  name: "Stripe",
  description:
    "Create a Stripe payment link (product + price + shareable checkout URL) so the owner can actually take money. Requires STRIPE_SECRET_KEY in the environment — an sk_test_… key creates a test-mode link (no real charges). Returns the checkout URL. This moves money; confirm with the owner.",
  safety: "external-state",
  concurrency: "parallel-safe",
  // Generous headroom: three sequential POSTs (product→price→link) that move
  // money must not be aborted mid-commit by the tight external-state default.
  watchdogTimeoutMs: 45_000,
  inputZod: inputSchema,
  activityDescription: (i) => `Creating Stripe payment link for ${i.name}`,

  async checkPermissions(i, ctx) {
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "Stripe is disabled in plan mode." };
    const live = !((await getCredential("STRIPE_SECRET_KEY")) ?? "").startsWith("sk_test_");
    const amount = (i.amount / 100).toFixed(2);
    return {
      kind: "ask",
      prompt: `Create a ${live ? "LIVE" : "test-mode"} Stripe payment link: "${i.name}" at ${amount} ${i.currency.toUpperCase()}?`,
      suggestion: live ? "deny" : "allow_once",
    };
  },

  async call(i, ctx): Promise<{ output: StripeOutput; display: string }> {
    const key = await getCredential("STRIPE_SECRET_KEY");
    if (!key) {
      throw new Error(
        "STRIPE_NO_KEY: no STRIPE_SECRET_KEY in the credential vault or environment (use an sk_test_… key for test mode). Ask the owner to add it.",
      );
    }
    const post = async (path: string, form: Record<string, string>) => {
      const res = await fetch(`${STRIPE_API}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: ctx.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const msg = (json.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
        throw new Error(`Stripe ${path} failed: ${msg}`);
      }
      return json;
    };

    const product = await post("/products", {
      name: i.name,
      ...(i.description ? { description: i.description } : {}),
    });
    const price = await post("/prices", {
      product: String(product.id),
      unit_amount: String(i.amount),
      currency: i.currency.toLowerCase(),
    });
    const link = await post("/payment_links", {
      "line_items[0][price]": String(price.id),
      "line_items[0][quantity]": "1",
      ...(i.quantity_adjustable
        ? { "line_items[0][adjustable_quantity][enabled]": "true" }
        : {}),
    });

    return {
      output: {
        url: String(link.url),
        paymentLinkId: String(link.id),
        productId: String(product.id),
        priceId: String(price.id),
        livemode: Boolean(link.livemode),
      },
      display: `Payment link ready${link.livemode ? "" : " (test mode)"} → ${String(link.url)}`,
    };
  },
});
