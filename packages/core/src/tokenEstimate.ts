// Content-aware token estimation (no tokenizer dependency).
//
// The engine budgets context with a chars/token heuristic and calibrates it
// against real provider usage (`tokenScale`). A flat 4 chars/token was wrong
// in both directions for the payloads that actually dominate a coding
// session: code/JSON/paths tokenize at ~3 chars/token (punctuation-heavy),
// CJK and emoji at ~1 token per character, base64/hex at ~2.5, while indent
// runs are nearly free. Under-estimating code is the dangerous direction —
// it is how a thread walks into context_length_exceeded — so classes are
// scored per line and images by pixel area when the header tells us.

import type { ImageBlock } from "@ares/protocol";

const CHARS_PER_TOKEN_PROSE = 4.0;
const CHARS_PER_TOKEN_CODE = 3.0;
const CHARS_PER_TOKEN_BASE64 = 2.5;
/** Tokenizers merge indentation: a run of up to ~12 spaces is ONE token. */
const INDENT_CHARS_PER_TOKEN = 12;
/** Share of punctuation + identifier boundaries (camelCase humps, digits
 *  beside letters) above which a line is scored as code/JSON/path. Prose
 *  sits near 0.02-0.06; a bare function signature is already ~0.14. */
const CODE_PUNCTUATION_RATIO = 0.12;

export const IMAGE_TOKEN_FLOOR = 256; // a small image still costs something
export const IMAGE_TOKEN_CAP = 2000; // providers downscale — per-image cost is bounded
/** Anthropic's documented rule: tokens ≈ width × height / 750, max ~1600. */
const IMAGE_PIXELS_PER_TOKEN = 750;
const IMAGE_KNOWN_DIMENSION_CAP = 1600;

const BASE64_LINE = /^[A-Za-z0-9+/=]{32,}$/;
const HEX_LINE = /^(?:0x)?[0-9a-fA-F]{32,}$/;

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals … unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) || // full-width forms
    (code >= 0x20000 && code <= 0x3134f) // extension planes
  );
}

function isEmoji(code: number): boolean {
  return (
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    code === 0x200d || code === 0xfe0f
  );
}

function isAsciiPunctuation(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

/** Estimated tokens for one line (no trailing newline). Exported for tests. */
export function estimateLineTokens(line: string): number {
  if (line.length === 0) return 0;
  let indent = 0;
  while (indent < line.length && (line[indent] === " " || line[indent] === "\t")) indent++;
  const body = line.slice(indent);
  let tokens = indent > 0 ? Math.ceil(indent / INDENT_CHARS_PER_TOKEN) : 0;
  if (body.length === 0) return tokens;
  if (BASE64_LINE.test(body) || HEX_LINE.test(body)) return tokens + body.length / CHARS_PER_TOKEN_BASE64;

  let letters = 0;
  let punctuation = 0;
  let boundaries = 0; // camelCase humps + letter/digit seams: identifiers split into several tokens
  let other = 0; // spaces + non-ASCII prose (Latin accents, Cyrillic, …)
  let heavy = 0; // CJK + emoji: ~1 token per character
  let prev = 0;
  for (const ch of body) {
    const code = ch.codePointAt(0) ?? 0;
    const lower = code >= 0x61 && code <= 0x7a;
    const upper = code >= 0x41 && code <= 0x5a;
    const digit = code >= 0x30 && code <= 0x39;
    if (isCjk(code) || isEmoji(code)) heavy++;
    else if (code < 0x80 && isAsciiPunctuation(code)) punctuation++;
    else if (lower || upper || digit) {
      letters++;
      const prevLower = prev >= 0x61 && prev <= 0x7a;
      const prevAlpha = prevLower || (prev >= 0x41 && prev <= 0x5a);
      const prevDigit = prev >= 0x30 && prev <= 0x39;
      if ((upper && prevLower) || (digit && prevAlpha) || (!digit && prevDigit)) boundaries++;
    } else other++;
    prev = code;
  }
  const visible = letters + punctuation;
  const codeLike = visible > 0 && (punctuation + boundaries) / visible >= CODE_PUNCTUATION_RATIO;
  const light = letters + punctuation + other;
  tokens += light / (codeLike ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE);
  tokens += heavy;
  return tokens;
}

/** Content-aware estimate for a text block. Never below 1 for non-empty text. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  let total = 0;
  let start = 0;
  let newlines = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 0x0a) {
      total += estimateLineTokens(text.slice(start, i));
      start = i + 1;
      if (i < text.length) newlines++;
    }
  }
  // A line break is usually merged into a neighbouring token, ~quarter each.
  total += newlines / CHARS_PER_TOKEN_PROSE;
  return Math.max(1, Math.ceil(total));
}

/** Decoded byte size of a base64 payload (3 bytes per 4 chars, minus padding). */
export function base64DecodedBytes(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Read width/height from the header of a base64 PNG/JPEG/GIF/WebP without
 *  decoding the pixels. Only the first 64KB is inspected (a JPEG SOF marker
 *  can sit behind EXIF/ICC segments). Returns null when unknown. */
export function imageDimensionsFromBase64(data: string): ImageDimensions | null {
  if (data.length < 32) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data.slice(0, 88_000), "base64");
  } catch {
    return null;
  }
  if (bytes.length < 24) return null;
  // PNG: 8-byte signature, IHDR length+type, then width/height big-endian.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return sane(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  // GIF: "GIF8?a" then width/height little-endian.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return sane(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  }
  // WebP: RIFF....WEBP then VP8 /VP8L/VP8X chunk.
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.length >= 30) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return sane(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    if (chunk === "VP8L") {
      const b = bytes.readUInt32LE(21);
      return sane(1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff));
    }
    if (chunk === "VP8 ") return sane(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    return null;
  }
  // JPEG: walk segments to the first SOF0/1/2 marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        offset += marker === 0xff ? 1 : 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return sane(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
      }
      if (marker === 0xda || length < 2) break; // start of scan — no SOF seen
      offset += 2 + length;
    }
  }
  return null;
}

function sane(width: number, height: number): ImageDimensions | null {
  return width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : null;
}

/** Token cost of an image for WINDOW accounting. Known dimensions use the
 *  provider's area rule (≈ w×h/750, capped 1600 — Anthropic downscales past
 *  that); otherwise the size-scaled guess bounded by floor/cap, so many
 *  frames still add up and trigger image-dropping while one screenshot never
 *  falsely evicts real text. */
export function estimateImageTokens(source: ImageBlock["source"], dimensions?: ImageDimensions | null): number {
  if (source.kind === "base64") {
    const dims = dimensions === undefined ? imageDimensionsFromBase64(source.data) : dimensions;
    if (dims) return Math.min(IMAGE_KNOWN_DIMENSION_CAP, Math.max(1, Math.ceil((dims.width * dims.height) / IMAGE_PIXELS_PER_TOKEN)));
    const bytes = base64DecodedBytes(source.data);
    return Math.min(IMAGE_TOKEN_CAP, Math.max(IMAGE_TOKEN_FLOOR, Math.ceil(bytes / 900)));
  }
  return IMAGE_TOKEN_FLOOR; // url image — true size unknown, rough floor
}
