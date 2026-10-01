// The phone's v2 connect contract, as types (docs/CONNECTIONS-OAUTH.md section 1).
// The garrison's ConnectHub implements ConnectBrokerV2; the /gateway/connections
// routes speak it. Every shape is JSON-safe and secret-free by construction:
// nothing here can carry a token, a code, a verifier or a client secret.

import type { ConnectBroker, ConnectService } from "./connectServices.js";

export interface SetupField {
  key: string;
  label: string;
  secret: boolean;
  hint: string;
  /** Public clients may leave a secret blank. */
  optional?: boolean;
}

export interface SetupStepV2 {
  title: string;
  body: string;
}

export type StartResult =
  | {
      state: "open";
      service: string;
      label: string;
      /** Open in the in-app auth session, then poll. */
      url: string;
      pollId: string;
      returnTo?: "ares://oauth";
      /** The redirect is a loopback address the app must intercept (POST /gateway/connections/complete). */
      intercept?: { redirectPrefix: string };
      experimental?: boolean;
    }
  | {
      state: "device";
      service: string;
      label: string;
      userCode: string;
      verificationUrl: string;
      verificationUrlComplete?: string;
      expiresInSec: number;
      intervalSec: number;
      pollId: string;
    }
  | {
      state: "setup";
      service: string;
      label: string;
      /** Present when the flow ends in a redirect (not for device-only apps). */
      redirectUri?: string;
      scopes: string[];
      consoleUrl?: string;
      appType?: string;
      steps: SetupStepV2[];
      fields: SetupField[];
      notes: string[];
      /** Why the automatic path could not be used (e.g. the vendor refused the redirect). */
      reason?: string;
    }
  | {
      state: "fields";
      service: string;
      label: string;
      /** Always true: this is an API-key fallback for a service with no OAuth. */
      notOAuth: true;
      reason: string;
      fields: SetupField[];
      /** POST here with {service, values}. */
      submit: "/gateway/connections/setup";
      /** The hub's secure-form page, for services whose setup is not just typing (Hue pairing). */
      url?: string;
      hint?: string;
    }
  | {
      state: "unsupported";
      service: string;
      label: string;
      reason: string;
      alternative?: { mode: "browser"; label: string; experimental: true };
    }
  | { state: "connected"; service: string; label: string };

export type PollState = "pending" | "connected" | "failed" | "expired";

export interface PollResult {
  state: PollState;
  service?: string;
  error?: string;
}

export type SetupResult =
  | { ok: true; state: "ready"; next: "start" }
  | { ok: true; state: "connected"; detail?: string }
  | { ok: true; state: "cleared" }
  | { ok: false; error: string };

export interface StartOptions {
  reason?: string;
  /** Only exactly "ares://oauth" is honoured. */
  returnTo?: string;
  mode?: "oauth" | "browser";
  /** Start even if the service reads as connected. */
  reconnect?: boolean;
}

export interface ConnectBrokerV2 extends ConnectBroker {
  startV2(service: ConnectService, opts?: StartOptions): Promise<StartResult>;
  pollFlow(pollId: string): PollResult | null;
  completeFlow(pollId: string, redirectUrl: string): Promise<PollResult | null>;
  setupService(service: ConnectService, values: Record<string, unknown>, opts?: { clear?: boolean }): Promise<SetupResult>;
}

export function isBrokerV2(broker: ConnectBroker | null | undefined): broker is ConnectBrokerV2 {
  return Boolean(broker && typeof (broker as ConnectBrokerV2).startV2 === "function");
}
