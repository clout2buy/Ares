// What "Connect" does for a service, decided from the matrix: a pure function,
// so the phone routes, the hub and the consistency test all agree.
//
// The owner's rule (2026-09-30): OAuth only. Where an OAuth path exists, NO
// pasted-token step appears in the connect flow. A service with a registered
// client gets one tap (or a device code); one that needs a client shows the
// one-time setup (never a token field); only a service with no OAuth at all
// (class e) falls back to honest, clearly-labelled key fields; a service with
// no API at all (class f) says so instead of faking a flow.

import type { ConnectService } from "./connectServices.js";
import { matrixFor, type OAuthClass, type OAuthMatrixEntry } from "./oauthMatrix.js";
import { OAUTH_PROVIDERS } from "./oauthProviders.js";

/** What the phone listing calls `auth`. */
export type AuthKind = "oauth" | "oauth-setup" | "device" | "key" | "browser" | "unsupported";
/** What `POST /gateway/connections/start {v:2}` answers FIRST for a service in its current state. */
export type StartKind = "open" | "device" | "setup" | "fields" | "unsupported";

export interface ConnectPlan {
  entry?: OAuthMatrixEntry;
  oauthClass?: OAuthClass;
  start: StartKind;
  auth: AuthKind;
  /** The client-registry / vault-slot id (oauthClients.ts). */
  provider?: string;
  /** A registered client is required before the flow can start. */
  needsClient: boolean;
  /** No registration is needed, or it is done. */
  setupDone: boolean;
  /** Which fields the one-time setup form takes. */
  setupFields: Array<{ key: "client_id" | "client_secret"; optional: boolean }>;
  /** The flow ends in a device code rather than a redirect. */
  device: boolean;
  /** An explicitly-labelled experimental browser session is available as an alternative. */
  browserAlternative?: { label: string; loginUrl: string; domain: string };
  /** Why `unsupported` / `fields`, in one honest sentence for the owner. */
  reason?: string;
}

export interface PlanContext {
  /** A client for the service's provider exists (vault or official). */
  client?: { hasSecret: boolean } | undefined;
}

/**
 * Does the vendor insist on a client SECRET (a confidential client)? Public
 * clients (device flow, PKCE) need only the client id. Config first, then what
 * the audit recorded for MCP servers that have no provider config.
 */
export function clientRequiresSecret(provider: string | undefined, entry?: OAuthMatrixEntry): boolean {
  const cfg = provider ? OAUTH_PROVIDERS[provider] : undefined;
  if (cfg) return !(cfg.publicClient || cfg.clientAuth === "none");
  return !(entry?.clientAuth === "none" || entry?.facts?.publicClient === true || entry?.flow === "device");
}

function fieldsFor(provider: string | undefined, entry: OAuthMatrixEntry | undefined): ConnectPlan["setupFields"] {
  const fromMatrix = entry?.setup?.fields ?? [];
  const wantsSecret = clientRequiresSecret(provider, entry);
  const out: ConnectPlan["setupFields"] = [{ key: "client_id", optional: false }];
  if (wantsSecret || fromMatrix.includes("client_secret")) out.push({ key: "client_secret", optional: !wantsSecret });
  return out;
}

const REASON_PARTNER = "this vendor only gives OAuth clients to approved partners, so there is nothing for you to register";

export function planConnect(service: ConnectService, ctx: PlanContext = {}): ConnectPlan {
  const entry = matrixFor(service.id);
  const provider = entry?.provider ?? service.oauthProvider ?? (service.kind === "oauth-app" ? service.id : undefined);
  const cls = entry?.class;
  const base = { ...(entry ? { entry } : {}), ...(cls ? { oauthClass: cls } : {}), ...(provider ? { provider } : {}) };
  const browserAlternative = service.browserFallback ?? (service.kind === "browser" && service.loginUrl && service.domain ? { label: `Experimental: sign in to ${service.label} on a live browser`, loginUrl: service.loginUrl, domain: service.domain } : undefined);
  const alt = browserAlternative ? { browserAlternative } : {};

  // ── no OAuth at all
  if (service.kind === "api-key" || service.kind === "mcp-key") {
    return { ...base, start: "fields", auth: "key", needsClient: false, setupDone: true, setupFields: [], device: false, reason: entry?.class === "n" ? "a local connector with nothing to sign in to" : "this service has no OAuth for personal use: it only issues API keys" };
  }
  if (service.kind === "browser" || cls === "f") {
    const reason = cls === "f" || !entry ? (entry?.notes ? firstSentence(entry.notes) : `${service.label} has no public API, so Ares can only use your logged-in browser session`) : REASON_PARTNER;
    return { ...base, start: "unsupported", auth: browserAlternative ? "browser" : "unsupported", needsClient: false, setupDone: true, setupFields: [], device: false, reason, ...alt };
  }

  // ── OAuth services
  const hasClient = Boolean(ctx.client);
  const prefersDevice = Boolean(entry && (entry.flow === "device" || cls === "d"));
  // An owner who registered a confidential web app (a secret) keeps the code flow; device needs a public client.
  const deviceNow = prefersDevice && (!ctx.client?.hasSecret || !OAUTH_PROVIDERS[provider ?? ""]);
  const zeroSetup = cls === "a" || Boolean(entry?.allowlist || entry?.loopback || entry?.cimd);

  if (service.kind === "mcp-oauth") {
    if (cls === "a" || !entry) return { ...base, start: "open", auth: "oauth", needsClient: false, setupDone: true, setupFields: [], device: false, ...alt };
    if (hasClient) return { ...base, start: prefersDevice ? "device" : "open", auth: prefersDevice ? "device" : "oauth", needsClient: true, setupDone: true, setupFields: fieldsFor(provider, entry), device: prefersDevice, ...alt };
    if (entry.selfServe === false) return { ...base, start: "unsupported", auth: "unsupported", needsClient: true, setupDone: false, setupFields: [], device: false, reason: REASON_PARTNER, ...alt };
    if (zeroSetup) return { ...base, start: "open", auth: "oauth", needsClient: false, setupDone: true, setupFields: [], device: false, ...alt };
    return { ...base, start: "setup", auth: "oauth-setup", needsClient: true, setupDone: false, setupFields: fieldsFor(provider, entry), device: prefersDevice, ...alt };
  }

  // oauth-app
  if (!hasClient) {
    if (entry?.selfServe === false) return { ...base, start: "unsupported", auth: "unsupported", needsClient: true, setupDone: false, setupFields: [], device: false, reason: REASON_PARTNER, ...alt };
    return { ...base, start: "setup", auth: "oauth-setup", needsClient: true, setupDone: false, setupFields: fieldsFor(provider, entry), device: prefersDevice, ...alt };
  }
  const device = deviceNow && Boolean(OAUTH_PROVIDERS[provider ?? ""]?.deviceUrl);
  return { ...base, start: device ? "device" : "open", auth: device ? "device" : "oauth", needsClient: true, setupDone: true, setupFields: fieldsFor(provider, entry), device, ...alt };
}

function firstSentence(text: string): string {
  const m = /^(.{20,220}?[.!?])(\s|$)/.exec(text.trim());
  return (m ? m[1]! : text.trim().slice(0, 200)).replace(/\s+/g, " ");
}

export interface SetupStep {
  title: string;
  body: string;
}

export interface SetupCopy {
  consoleUrl?: string;
  appType?: string;
  steps: SetupStep[];
  /** Extra honest notes (review gates, personal-account limits). */
  notes: string[];
}

/** The one-time registration copy for a service, from the matrix (or the registry's own appSetup). */
export function setupCopy(service: ConnectService, plan: ConnectPlan, redirectUri?: string): SetupCopy {
  const m = plan.entry?.setup;
  const rawSteps = m?.steps?.length ? m.steps : service.appSetup?.steps ?? [];
  const steps: SetupStep[] = rawSteps.map((body, i) => ({ title: `Step ${i + 1}`, body }));
  if (redirectUri && !plan.device) steps.push({ title: "Redirect URI", body: `Register exactly this redirect URI on the app: ${redirectUri}` });
  if (plan.device && m?.deviceFlowCheckbox) steps.push({ title: "Device flow", body: `Turn on: ${m.deviceFlowCheckbox}` });
  const notes: string[] = [];
  if (m?.reviewRequired) notes.push(m.reviewRequired);
  if (plan.entry?.notes && plan.entry.class !== "a") notes.push(firstSentence(plan.entry.notes));
  return {
    ...(m?.consoleUrl ?? service.appSetup?.consoleUrl ? { consoleUrl: (m?.consoleUrl ?? service.appSetup?.consoleUrl)! } : {}),
    ...(m?.appType ? { appType: m.appType } : {}),
    steps,
    notes,
  };
}
