// Connect-hub verifiers for the universal connectors.
//
//   api-<id>  any service of the Api tool: the typed values are used for ONE
//             read-only call (the service's verify operation, or the first
//             parameter-free GET) BEFORE anything is stored, so a wrong key
//             fails on the phone form, not three turns later.
//   mqtt      connect to the broker with the typed URL and say hello.

import { isApiConnectId } from "@ares/core";
import { MqttClient, parseMqttUrl, verifyApiService } from "@ares/tools";
import type { VerifyOutcome } from "./connectVerifiersLife.js";

export type ApiVerify = (values: Record<string, string>, signal: AbortSignal) => Promise<VerifyOutcome>;

/** The verifier for a connect-service id that is an Api service, else undefined. */
export function apiVerifierFor(connectId: string, home?: string): ApiVerify | undefined {
  if (!isApiConnectId(connectId)) return undefined;
  const serviceId = connectId.slice(4);
  return async (values, signal) => verifyApiService(serviceId, values, { signal, ...(home ? { home } : {}) });
}

export const UNIVERSAL_VERIFIERS: Record<string, ApiVerify> = {
  async mqtt(values, signal) {
    const endpoint = parseMqttUrl(values.MQTT_URL!);
    const client = await MqttClient.connect({ ...endpoint, signal, connectTimeoutMs: 8_000 });
    client.close();
    return `Connected to the broker at ${endpoint.host}:${endpoint.port}${endpoint.tls ? " over TLS" : ""}.`;
  },
};
