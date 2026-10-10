// The connect hub's Plaid half — "connect my bank" in one tap.
//
// Plaid Hosted Link (https://plaid.com/docs/link/hosted-link/): Ares asks
// /link/token/create for a session with a `hosted_link` object and gets back a
// hosted_link_url — Plaid's own bank picker and sign-in, on Plaid's domain.
// The flow's landing page (/connect/<flow>) 302s there. The bank password is
// typed into Plaid, never into Ares.
//
// Completion is detected by whichever comes first:
//   redirect  Plaid sends the browser to hosted_link.completion_redirect_uri,
//             <origin>/connect/plaid-done (ONE fixed address, so the owner can
//             allow-list it in the dashboard once)
//   webhook   SESSION_FINISHED at <origin>/connect/plaid-webhook
//   polling   /link/token/get every few seconds while the flow is pending,
//             bounded by the flow's lifetime
// None of them is trusted for the result: redirect and webhook are unsigned
// hints that only trigger a /link/token/get — an authenticated call to Plaid —
// and the public tokens come from ITS answer (results.item_add_results[]).
// A check is single-flight per flow, so a redirect racing a poll exchanges each
// public token once.
//
// Stage A (no keys yet): the landing page is a setup form for the owner's own
// Plaid keys; they're proven with /institutions/get before anything is stored,
// and the owner goes straight on to the bank picker.
//
// Update mode (service "plaid:update:<item_id>"): the link token carries the
// Item's access_token and no products; success is the session finishing
// without an exit — there is nothing to exchange, the Item is the same.

import type { IncomingMessage, ServerResponse } from "node:http";
import { isPlaidService, plaidUpdateItemId, setCredential, type ConnectService } from "@ares/core";
import {
  PlaidError,
  clearBankCache,
  exchangePlaidPublicTokens,
  loadPlaidConfig,
  loadPlaidItems,
  normalizePlaidEnv,
  plaidCall,
  plaidErrorSentence,
  type PlaidConfig,
} from "@ares/tools";

export interface PlaidFlowState {
  linkToken: string;
  hostedUrl: string;
  updateItemId?: string;
  polling?: boolean;
  checking?: Promise<void>;
}

/** The parts of a hub flow this module reads and writes. */
export interface PlaidFlow {
  id: string;
  service: ConnectService;
  createdAt: number;
  status: "pending" | "ok" | "failed";
  plaid?: PlaidFlowState;
}

export interface PlaidLinkOptions {
  home?: string;
  log: (line: string) => void;
  /** How often a pending flow asks /link/token/get (default 3 s). */
  pollMs?: number;
  /** A flow's lifetime — polling stops with it. */
  ttlMs: number;
  complete: (flow: PlaidFlow, ok: boolean, detail: string) => void;
  flows: () => Iterable<PlaidFlow>;
}

export const PLAID_DONE_PATH = "/connect/plaid-done";
export const PLAID_WEBHOOK_PATH = "/connect/plaid-webhook";
const MAX_WEBHOOK_BYTES = 64 * 1024;

export { isPlaidService };

export class PlaidLink {
  private readonly pollMs: number;

  constructor(private readonly opts: PlaidLinkOptions) {
    this.pollMs = Math.max(50, opts.pollMs ?? 3_000);
  }

  async hasKeys(): Promise<boolean> {
    return (await loadPlaidConfig(this.opts.home)) !== null;
  }

  /** Stage B: mint the Hosted Link session. Throws Plaid's sentence. */
  async prepare(flow: PlaidFlow, base: string): Promise<void> {
    const cfg = await loadPlaidConfig(this.opts.home);
    if (!cfg) throw new Error("Plaid isn't set up yet");
    const updateItemId = plaidUpdateItemId(flow.service);
    let accessToken: string | undefined;
    if (updateItemId) {
      const item = (await loadPlaidItems(this.opts.home)).find((i) => i.item_id === updateItemId);
      if (!item) throw new Error(`no linked bank has item_id ${updateItemId} — call Bank items to see them`);
      accessToken = item.access_token;
    }
    const body: Record<string, unknown> = {
      client_name: "Ares",
      user: { client_user_id: "ares-owner" },
      country_codes: ["US", "CA"],
      language: "en",
      hosted_link: { completion_redirect_uri: `${base}${PLAID_DONE_PATH}`, url_lifetime_seconds: 1800 },
    };
    if (accessToken) {
      // Update mode: products are omitted and the webhook field has no effect.
      body.access_token = accessToken;
    } else {
      body.products = ["transactions"];
      body.transactions = { days_requested: 365 };
      // Consent only — billed when first used (/liabilities/get,
      // /investments/holdings/get), and never a reason for Link to refuse a bank.
      body.additional_consented_products = ["liabilities", "investments"];
      body.webhook = `${base}${PLAID_WEBHOOK_PATH}`;
    }
    let res: Record<string, any>;
    try {
      res = await plaidCall(cfg, "/link/token/create", body);
    } catch (err) {
      throw new Error(plaidErrorSentence(err));
    }
    const linkToken = String(res.link_token ?? "");
    const hostedUrl = String(res.hosted_link_url ?? "");
    if (!linkToken || !/^https:\/\//.test(hostedUrl)) throw new Error("Plaid returned no Hosted Link URL (is Hosted Link enabled for this Plaid account?)");
    flow.plaid = { linkToken, hostedUrl, ...(updateItemId ? { updateItemId } : {}) };
    this.opts.log(`connect: plaid link session ready${updateItemId ? " (update mode)" : ""}`);
  }

  /** Stage A: prove the owner's keys, store them, mint the session. */
  async submitSetup(flow: PlaidFlow, form: Record<string, string>, base: string): Promise<{ url: string } | { error: string }> {
    const clientId = (form.PLAID_CLIENT_ID ?? "").trim();
    const secret = (form.PLAID_SECRET ?? "").trim();
    const env = normalizePlaidEnv(form.PLAID_ENV);
    if (!clientId || !secret) return { error: "Both the client_id and the secret are needed." };
    const cfg: PlaidConfig = { clientId, secret, env };
    try {
      await plaidCall(cfg, "/institutions/get", { count: 1, offset: 0, country_codes: ["US"] }, AbortSignal.timeout(20_000));
    } catch (err) {
      if (err instanceof PlaidError && /INVALID_API_KEYS|INVALID_SECRET|INVALID_CLIENT_ID/.test(err.code))
        return { error: `Plaid doesn't recognise those keys for ${env}. Check you copied the ${env === "production" ? "Production" : "Sandbox"} secret (each environment has its own).` };
      return { error: plaidErrorSentence(err) };
    }
    await setCredential("PLAID_CLIENT_ID", clientId, { home: this.opts.home });
    await setCredential("PLAID_SECRET", secret, { home: this.opts.home });
    await setCredential("PLAID_ENV", env, { home: this.opts.home });
    try {
      await this.prepare(flow, base);
    } catch (err) {
      return { error: `Your keys are saved, but Plaid wouldn't start a bank link: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.startPolling(flow);
    return { url: flow.plaid!.hostedUrl };
  }

  /** Poll /link/token/get until the flow settles or expires. */
  startPolling(flow: PlaidFlow): void {
    if (!flow.plaid || flow.plaid.polling) return;
    flow.plaid.polling = true;
    let delay = this.pollMs;
    const tick = async () => {
      if (flow.status !== "pending" || Date.now() - flow.createdAt > this.opts.ttlMs) {
        if (flow.plaid) flow.plaid.polling = false;
        return;
      }
      try {
        await this.check(flow);
        delay = this.pollMs;
      } catch (err) {
        // A rate limit backs off; anything else is logged and retried.
        if (err instanceof PlaidError && err.rateLimited) delay = Math.min(delay * 2, 60_000);
        this.opts.log(`connect: plaid poll — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (flow.status === "pending") {
        const timer = setTimeout(() => void tick(), delay);
        timer.unref?.();
      } else if (flow.plaid) flow.plaid.polling = false;
    };
    const timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  }

  /** Ask Plaid how the session went; settle the flow if it finished. */
  check(flow: PlaidFlow): Promise<void> {
    if (!flow.plaid || flow.status !== "pending") return Promise.resolve();
    flow.plaid.checking ??= this.checkOnce(flow).finally(() => {
      if (flow.plaid) delete flow.plaid.checking;
    });
    return flow.plaid.checking;
  }

  private async checkOnce(flow: PlaidFlow): Promise<void> {
    const state = flow.plaid!;
    const cfg = await loadPlaidConfig(this.opts.home);
    if (!cfg) return;
    const got = await plaidCall(cfg, "/link/token/get", { link_token: state.linkToken });
    if (flow.status !== "pending") return;
    const sessions = (Array.isArray(got.link_sessions) ? got.link_sessions : []) as Array<Record<string, any>>;
    const results = sessions.flatMap((s) => (Array.isArray(s.results?.item_add_results) ? s.results.item_add_results : [])) as Array<Record<string, any>>;
    const finished = sessions.filter((s) => s.finished_at);
    if (state.updateItemId) {
      const good = results.length > 0 || finished.some((s) => !s.exit);
      if (good) {
        clearBankCache();
        const item = (await loadPlaidItems(this.opts.home)).find((i) => i.item_id === state.updateItemId);
        this.opts.complete(flow, true, `Reconnected ${item?.institution_name ?? "the bank"} — Ares can read it again.`);
        return;
      }
    } else if (results.length) {
      const withTokens = results.filter((r) => typeof r.public_token === "string" && r.public_token);
      if (withTokens.length) {
        try {
          const added = await exchangePlaidPublicTokens(
            cfg,
            withTokens.map((r) => ({ public_token: String(r.public_token), institution: r.institution, accounts: r.accounts })),
            { home: this.opts.home },
          );
          clearBankCache();
          this.opts.complete(flow, true, added.map((a) => `Connected ${a.institution} (${a.accounts} account${a.accounts === 1 ? "" : "s"})`).join("; ") + ".");
        } catch (err) {
          this.opts.complete(flow, false, `Plaid linked the bank but the token exchange failed: ${plaidErrorSentence(err)}`);
        }
        return;
      }
    }
    const exited = finished.find((s) => s.exit);
    if (exited && finished.length === sessions.length) {
      const why = exited.exit?.error?.display_message ?? exited.exit?.error?.error_message ?? exited.exit?.error?.error_code;
      this.opts.complete(flow, false, why ? `Plaid stopped: ${String(why).slice(0, 200)}` : "The owner closed Plaid without linking a bank.");
    }
  }

  /** The shared addresses: the completion redirect and the webhook. */
  async handleShared(req: IncomingMessage, res: ServerResponse, url: URL, render: { page: (res: ServerResponse, status: number, html: string) => void; resultPage: (ok: boolean, title: string, detail: string) => string }): Promise<boolean> {
    if (url.pathname.replace(/\/+$/, "") === PLAID_DONE_PATH) {
      const pending = [...this.opts.flows()].filter((f) => isPlaidService(f.service) && f.plaid && f.status === "pending");
      await Promise.all(pending.map((f) => this.check(f).catch((err) => this.opts.log(`connect: plaid check — ${err instanceof Error ? err.message : String(err)}`))));
      const ok = pending.some((f) => f.status === "ok");
      const failed = pending.length > 0 && pending.every((f) => f.status === "failed");
      if (failed) render.page(res, 200, render.resultPage(false, "Bank not connected", "Go back to Ares — it can try again."));
      else render.page(res, 200, render.resultPage(true, ok ? "Bank connected" : "Almost done", ok ? "Go back to Ares — it can read your accounts now." : "Go back to Ares — it's finishing the connection."));
      return true;
    }
    if (url.pathname.replace(/\/+$/, "") === PLAID_WEBHOOK_PATH) {
      if (req.method !== "POST") {
        res.writeHead(405, { "cache-control": "no-store" });
        res.end();
        return true;
      }
      const body = await readJsonBody(req);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end('{"ok":true}');
      const code = String(body.webhook_code ?? "");
      const type = String(body.webhook_type ?? "");
      if (code === "SESSION_FINISHED" || (type === "LINK" && body.link_token)) {
        const flow = [...this.opts.flows()].find((f) => f.plaid?.linkToken && f.plaid.linkToken === body.link_token && f.status === "pending");
        if (flow) void this.check(flow).catch((err) => this.opts.log(`connect: plaid webhook check — ${err instanceof Error ? err.message : String(err)}`));
      } else if (type === "TRANSACTIONS" || type === "ITEM") {
        // New transactions or an Item error: the next Bank call should look again.
        clearBankCache();
      }
      return true;
    }
    return false;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_WEBHOOK_BYTES) return {};
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One line for the connect card. */
export function plaidInstructions(flow: PlaidFlow): string {
  if (flow.plaid?.updateItemId) return "Sign in to your bank again in Plaid. Same connection — nothing else changes.";
  if (flow.plaid) return "Pick your bank in Plaid and sign in there. Ares gets read-only access.";
  return "One-time setup: paste your free Plaid keys, then pick your bank.";
}

/** Stage A's page body (the hub wraps it in its page shell). */
export function plaidSetupBody(flow: PlaidFlow & { reason?: string }, base: string, error?: string): string {
  const setup = flow.service.appSetup;
  const steps = (setup?.steps ?? []).map((s) => `<li>${esc(s)}</li>`).join("");
  return `<main><div class="mark">🏦</div><h1>Connect your bank</h1>${flow.reason ? `<p>Ares needs this ${esc(flow.reason)}.</p>` : ""}<p>Ares reads your banks through your own Plaid account. This is a one-time setup; after it, adding a bank is one tap and you pick it in Plaid's own screen.</p>${
    setup ? `<p><a href="${esc(setup.consoleUrl)}" target="_blank" rel="noopener">Open dashboard.plaid.com ↗</a></p>` : ""
  }<ol>${steps}</ol><label>Completion address</label><code>${esc(`${base}${PLAID_DONE_PATH}`)}</code>${error ? `<div class="err">${esc(error)}</div>` : ""}<form method="post"><label for="PLAID_CLIENT_ID">client_id</label><input id="PLAID_CLIENT_ID" name="PLAID_CLIENT_ID" autocomplete="off" autocapitalize="off" spellcheck="false" required><label for="PLAID_SECRET">Secret</label><input id="PLAID_SECRET" name="PLAID_SECRET" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required><div class="help">Each environment has its own secret.</div><label for="PLAID_ENV">Environment</label><select id="PLAID_ENV" name="PLAID_ENV" style="width:100%;padding:.8rem .9rem;border-radius:.75rem;border:1px solid #2a3038;background:#12161b;color:#eceff3;font-size:1rem"><option value="production" selected>Production — your real banks</option><option value="sandbox">Sandbox — test banks (user_good / pass_good)</option></select><button type="submit">Save and pick my bank</button></form><p class="help" style="margin-top:1rem">Your keys are checked with Plaid, then stored encrypted on your Ares. Your bank password is only ever typed into Plaid.</p></main>`;
}
