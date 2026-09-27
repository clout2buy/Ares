// Track — Ares's ledger of open commitments (see tracking.ts for why).
//
// The doctrine is in the description on purpose: this is a deferred tool, so
// the description is the one text the model is guaranteed to read before it
// calls it. The prompt-side doctrine (toolDoctrine.ts) only has to make the
// model load it after booking, ordering or promising something.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { TrackingStore, TRACKING_KINDS, type TrackingItem } from "./tracking.js";

const inputSchema = z
  .object({
    action: z.enum(["add", "update", "list", "close"]).describe(
      "add: open a new tracked commitment. update: change status/detail/due time. list: show items. close: resolve one as done or cancelled.",
    ),
    title: z.string().optional().describe("add: short name, e.g. 'Dinner at Nopa, Fri 8pm (4 people)'."),
    kind: z.enum(TRACKING_KINDS).optional().describe("add: reservation | delivery | order | reminder | promise | other."),
    detail: z.string().optional().describe("Confirmation numbers, tracking numbers, who/where, what to check next."),
    dueAt: z.string().optional().describe("ISO 8601 time it is due / expected (reservation time, delivery ETA, when you promised to follow up)."),
    url: z.string().optional().describe("Link to the booking, order or tracking page."),
    id: z.string().optional().describe("update/close: the item id (trk_…)."),
    status: z.enum(["open", "done", "cancelled"]).optional().describe("update: new status. close: done | cancelled (default done). list: filter."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface TrackOutput {
  ok: boolean;
  item?: TrackingItem;
  items?: TrackingItem[];
  message: string;
}

function line(i: TrackingItem): string {
  return `${i.id} [${i.status}] ${i.kind}: ${i.title}${i.dueAt ? ` — due ${i.dueAt}` : ""}${i.detail ? ` — ${i.detail.slice(0, 160)}` : ""}`;
}

export const TrackTool = buildTool<typeof inputSchema, TrackOutput>({
  name: "Track",
  description:
    "Track open commitments until they are resolved: reservations, deliveries, orders, reminders, promises. " +
    "Whenever you book, order, reserve or promise something for the owner, call Track add in the same turn (title, kind, dueAt, confirmation details, url) — it appears on the owner's Today tab. " +
    "When it resolves (the delivery arrived, the dinner happened, the promise is kept) call Track close. " +
    "Before telling the owner what's pending, call Track list. Overdue open items come back to you on the heartbeat: follow up, then update or close them.",
  safety: "workspace-write",
  dynamicSafety: (input) => (input.action === "list" ? "read-only" : "workspace-write"),
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => {
    if (i.action === "add") return `Tracking: ${i.title ?? "commitment"}`;
    if (i.action === "close") return `Closing tracked item ${i.id ?? ""}`.trim();
    if (i.action === "update") return `Updating tracked item ${i.id ?? ""}`.trim();
    return "Listing tracked commitments";
  },
  async call(input: Input): Promise<ToolResult<TrackOutput>> {
    const store = new TrackingStore();
    const fail = (message: string): ToolResult<TrackOutput> => ({ output: { ok: false, message }, display: message, failure: message });
    switch (input.action) {
      case "add": {
        if (!input.title?.trim()) return fail("add needs a title.");
        const item = await store.add({ title: input.title, kind: input.kind, detail: input.detail, dueAt: input.dueAt, url: input.url });
        const message = `Tracking ${item.id}: ${item.title}${item.dueAt ? ` (due ${item.dueAt})` : ""}.`;
        return { output: { ok: true, item, message }, display: message };
      }
      case "update": {
        if (!input.id) return fail("update needs id.");
        const item = await store.update(input.id, { status: input.status, detail: input.detail, dueAt: input.dueAt, title: input.title, url: input.url });
        if (!item) return fail(`No tracked item "${input.id}" — call Track list.`);
        const message = `Updated ${line(item)}`;
        return { output: { ok: true, item, message }, display: message };
      }
      case "close": {
        if (!input.id) return fail("close needs id.");
        const status = input.status === "cancelled" ? "cancelled" : "done";
        const item = await store.close(input.id, status);
        if (!item) return fail(`No tracked item "${input.id}" — call Track list.`);
        const message = `Closed ${item.id} as ${status}: ${item.title}.`;
        return { output: { ok: true, item, message }, display: message };
      }
      case "list":
      default: {
        const items = input.status ? await store.list(input.status) : await store.forPhone();
        const message = items.length ? items.map(line).join("\n") : "Nothing tracked.";
        return { output: { ok: true, items, message }, display: message.slice(0, 400) };
      }
    }
  },
});
