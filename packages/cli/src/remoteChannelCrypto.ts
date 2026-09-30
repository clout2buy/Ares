// Channel MACs for the paired-device protocol — authentication for every
// post-handshake frame, not just the handshake itself.
//
// WHY THIS EXISTS
//
// The mutual proof-of-possession handshake (remoteDeviceCrypto.ts) answers
// "am I talking to my real owner / my real device?" exactly once, at attach.
// It proves nothing about the frames that follow: after device_ready the
// channel is plain ws:// JSON, so an on-path attacker (ARP spoof, rogue AP,
// a host that answers the LAN discovery probe with its own address) can relay
// the handshake byte-for-byte — both proofs PASS, because the relayed proofs
// ARE genuine — and then inject exec/putfile/update frames on the same
// socket. On an elevated connector that is remote admin execution handed to
// whoever sits on the path. The handshake stops the OFF-path spoofer; it is
// invisible to the ON-path relayer. This module closes that gap: both sides
// already hold shared secrets that never cross the wire, so every subsequent
// frame can be keyed to them.
//
// CONSTRUCTION
//
//   channelKeys(deviceSecret, serverKey, deviceNonce, serverNonce)
//     ikm   = 32-byte decoded deviceSecret || 32-byte decoded serverKey
//     salt  = 32-byte decoded deviceNonce || 32-byte decoded serverNonce
//     PRK   = HMAC-SHA256(salt, ikm)                 // HKDF-Extract
//     K_s2d = HKDF-Expand(PRK, "ares-remote-channel/1 s2d", 32)
//     K_d2s = HKDF-Expand(PRK, "ares-remote-channel/1 d2s", 32)
//
//   mac = HMAC-SHA256(K_dir, "ares-remote-channel/1 mac/1" ‖ ver ‖ dir ‖ seq64 ‖ len64 ‖ payload)
//
//     dir        = 0x01 (s2d) | 0x02 (d2s)   — binary, never a string
//     seq64/len64 = big-endian uint64
//     payload    = the exact UTF-8 bytes of the JSON text on the wire
//                  INCLUDING its closing "}" and the ,"seq":"N" field,
//                  EXCLUDING the ,"mac":"…" suffix
//
// All HKDF inputs are strict-length decoded (32 bytes) so the ikm/salt
// concatenations are unambiguous; a credential of any other shape fails
// closed rather than concatenating ambiguous material.
//
// ENVELOPE GRAMMAR
//
//   {"type":"exec",…,"seq":"0","mac":"<64 lowercase hex>"}
//
// seq is a decimal string (no float traps at 2^53). Senders refuse to seal a
// serialization that does not end in the structural "}". Receivers strip a
// strictly validated ,"mac":"…" suffix and MAC the exact remaining bytes —
// never parse-delete-reserialize. The seq inside the authenticated bytes must
// equal the receiver's expected counter: no gaps, no windows (a single
// ordered TCP/WS stream means a gap is a dropped or injected frame, and the
// channel dies). Nothing dispatches before the MAC verifies.
//
// CAPABILITY SIGNALLING
//
// A v5 device proves its capability in the device_auth proof FORM ITSELF:
//   legacy:  HMAC(deviceSecret, "device:" + serverNonce)
//   v5:      HMAC(deviceSecret, "device:mac1:<version>:" + serverNonce)
// The server tries the v5 form first, then legacy, and enables MAC
// enforcement only when the v5 form matched. A relay cannot strip the
// capability: it never travelled in an unauthenticated field — it IS the
// proof — and it cannot be forged without the secret. v5 device code has no
// legacy mode at all: every v5 attach enforces MACs or dies.
//
// WHAT THIS DOES NOT DO (stated so nobody overclaims)
//
//   * No confidentiality — commands/files/results stay visible to an
//     on-path reader. Integrity + authenticity only.
//   * No DoS defense — an on-path attacker can always cut a connection.
//   * Enrollment (the first socket) is not protected: the one-time link is
//     the anchor, and an on-path observer of THAT socket learns the permanent
//     secrets. This protects every session after a clean enrollment.
//   * The v4→v5 bootstrap update cannot ride a MAC that does not exist yet —
//     a documented migration gap, closed by each device's first
//     authenticated v5 attach.

import { createHmac, timingSafeEqual } from "node:crypto";

export const CHANNEL_LABEL = "ares-remote-channel/1";
/** Capability/mode tag: bound into the v5 auth proof and HKDF labels. */
export const CHANNEL_MODE = "mac1";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Strict base64url decode to exactly `expect` bytes, else null. */
function decodeExact(input: string, expect: number): Buffer | null {
  if (typeof input !== "string" || input.length === 0 || !BASE64URL.test(input)) return null;
  const buf = Buffer.from(input, "base64url");
  if (buf.length !== expect) return null;
  return buf;
}

export interface ChannelKeys {
  s2d: Buffer;
  d2s: Buffer;
}

/**
 * Derive the two direction keys from the handshake transcript.
 * Null (fail closed) unless both secrets and both nonces decode to exactly
 * 32 bytes — the shapes mintDeviceCredential() and mintNonce() produce.
 */
export function channelKeys(
  deviceSecret: string,
  serverKey: string,
  deviceNonce: string,
  serverNonce: string,
): ChannelKeys | null {
  const ds = decodeExact(deviceSecret, 32);
  const sk = decodeExact(serverKey, 32);
  const dn = decodeExact(deviceNonce, 32);
  const sn = decodeExact(serverNonce, 32);
  if (!ds || !sk || !dn || !sn) return null;
  const ikm = Buffer.concat([ds, sk]);
  const salt = Buffer.concat([dn, sn]);
  // RFC 5869, written explicitly so the PowerShell 5.1 connector can use the
  // identical construction without relying on a framework HKDF API it does
  // not have. Both outputs fit in one SHA-256 expand block.
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const expand = (info: string): Buffer =>
    createHmac("sha256", prk)
      .update(Buffer.from(info, "utf8"))
      .update(Buffer.from([0x01]))
      .digest();
  const s2d = expand(`${CHANNEL_LABEL} s2d`);
  const d2s = expand(`${CHANNEL_LABEL} d2s`);
  return { s2d, d2s };
}

/**
 * MAC input framing: label ‖ ver ‖ dir ‖ seq64 ‖ len64 ‖ payload.
 * Fixed-size binary head before the payload: no delimiters needed, and the
 * payload length is authenticated.
 */
function macInput(dir: 0x01 | 0x02, seq: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(1 + 1 + 8 + 8);
  head.writeUInt8(1, 0); // framing version
  head.writeUInt8(dir, 1);
  head.writeBigUInt64BE(BigInt(seq), 2);
  head.writeBigUInt64BE(BigInt(payload.length), 10);
  return Buffer.concat([Buffer.from(`${CHANNEL_LABEL} mac/1`, "utf8"), head, payload]);
}

/** Compute the hex MAC for a frame one side is about to send. */
export function channelMac(key: Buffer, dir: 0x01 | 0x02, seq: number, payload: string): string {
  return createHmac("sha256", key).update(macInput(dir, seq, Buffer.from(payload, "utf8"))).digest("hex");
}

export function macsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/**
 * Seal a serialized frame: append ,"seq":"N","mac":"…" so the covered bytes
 * are the serialization plus the seq field plus the closing brace. Returns
 * null unless `serialized` ends in the structural "}" — blind substring
 * surgery on an array, a scalar, or a failed serialization must not
 * silently produce a mis-MACed frame.
 */
export function sealFrame(key: Buffer, dir: 0x01 | 0x02, seq: number, serialized: string): string | null {
  if (!serialized.endsWith("}")) return null;
  const covered = `${serialized.slice(0, -1)},"seq":"${seq}"}`;
  const mac = channelMac(key, dir, seq, covered);
  return `${covered.slice(0, -1)},"mac":"${mac}"}`;
}

export interface VerifiedFrame {
  /** The authenticated JSON text (covered bytes), exactly as received. */
  payload: string;
  /** The authenticated sequence value. */
  seq: number;
}

/**
 * Verify and unseal one received frame.
 *
 * Strict grammar: must end ,"seq":"<decimal>","mac":"<64 lowercase hex>"}.
 * The MAC covers everything from the opening byte through the closing brace
 * of the covered text. The envelope seq must equal `expectSeq` — exact match,
 * no gaps, no windows. Returns null on ANY deviation; the caller terminates
 * the socket, because on a MACed channel there is no recoverable bad frame.
 */
export function openFrame(key: Buffer, dir: 0x01 | 0x02, expectSeq: number, text: string): VerifiedFrame | null {
  if (typeof text !== "string" || text.length === 0 || !text.endsWith("}")) return null;
  const m = /^(.*),"seq":"(\d{1,15})","mac":"([0-9a-f]{64})"\}$/.exec(text);
  if (!m) return null;
  // The MAC covered m[1] + the seq field + the closing brace — rebuild it
  // exactly as sealFrame constructed it, or the comparison is over different
  // bytes and every good frame fails.
  const covered = `${m[1]},"seq":"${m[2]}"}`;
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq) || seq !== expectSeq) return null;
  const want = channelMac(key, dir, seq, covered);
  if (!macsEqual(m[3], want)) return null;
  return { payload: covered, seq };
}

/**
 * The v5 device_auth proof. Same key and nonce as the legacy proofFor(), but
 * the label embeds the mode, so the proof form itself announces the
 * capability — nothing unauthenticated decides whether the channel is
 * MAC-protected, and a legacy-form proof from a v5 device is a protocol
 * violation the server refuses to enable MACs on.
 */
export function channelAuthProof(deviceSecret: string, serverNonce: string, connectorVersion = 5): string {
  return createHmac("sha256", deviceSecret)
    .update(`device:${CHANNEL_MODE}:${connectorVersion}:${serverNonce}`, "utf8")
    .digest("hex");
}