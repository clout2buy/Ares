/**
 * The bytes decide an image's format; a declared media type is only a client's
 * claim about them. The iOS app labels its JPEG screenshots `image/png`, and
 * Anthropic refuses the ENTIRE request over the mismatch — "The image was
 * specified using the image/png media type, but the image appears to be a
 * image/jpeg image". One such block in a thread's history therefore bricks every
 * later turn in that thread, permanently, because the poison is re-sent on every
 * request (that is exactly what happened at 07:16 on 2026-10-01; three turns
 * died on it, including the first heartbeat alert).
 *
 * Correcting the label on the way to the wire — rather than only at ingestion —
 * is what lets an already-stored bad block heal instead of forcing the thread to
 * be abandoned.
 */

/** Magic-byte signatures, checked in order. JPEG is tested separately from the
 *  rest so a truncated capture still resolves. */
const SIGNATURES: ReadonlyArray<{ mediaType: string; matches: (head: Uint8Array) => boolean }> = [
  { mediaType: "image/png", matches: (b) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mediaType: "image/jpeg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: "image/gif", matches: (b) => b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mediaType: "image/webp",
    matches: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

/** The format the bytes actually are, or undefined when nothing recognisable
 *  (an unsupported format, or a sender that base64d something else entirely). */
export function sniffImageMediaType(base64: string): string | undefined {
  if (!base64) return undefined;
  // 32 base64 chars decode to 24 bytes — comfortably past every signature above.
  let head: Uint8Array;
  try {
    head = Buffer.from(base64.slice(0, 32), "base64");
  } catch {
    return undefined;
  }
  for (const signature of SIGNATURES) {
    if (signature.matches(head)) return signature.mediaType;
  }
  return undefined;
}

/** What to put on the wire: the sniffed type when the bytes are recognisable and
 *  disagree with the claim, otherwise the claim untouched — an unusual-but-valid
 *  format the sniffer doesn't know must not be mangled into a wrong answer. */
export function imageMediaTypeFor(declared: string, base64: string): string {
  const sniffed = sniffImageMediaType(base64);
  return sniffed && sniffed !== declared ? sniffed : declared;
}
