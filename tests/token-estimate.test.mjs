// Content-aware token estimator (packages/core/src/tokenEstimate.ts).
//
// Relative ordering is the contract: code costs more per char than prose,
// CJK costs far more than ASCII, base64 is denser still, indents are cheap;
// images are priced by pixel area when the header is readable. A mixed
// English+code sample must land between 3 and 4.5 chars/token.

import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateTextTokens,
  estimateLineTokens,
  estimateImageTokens,
  imageDimensionsFromBase64,
  base64DecodedBytes,
} from "../packages/core/dist/index.js";

const PROSE = "The verifier runs the narrowest meaningful check after every edit so the model cannot claim done while the build is red. ".repeat(6);
const CODE = [
  "export function estimateBlockTokens(b: ContentBlock): number {",
  "  const memoizable = typeof b === \"object\" && b !== null;",
  "  if (memoizable) { const cached = blockTokenMemo.get(b); if (cached !== undefined) return cached; }",
  "  return computeBlockTokens({ ...b, path: path.join(root, \".ares\", \"tool-results\") });",
  "}",
].join("\n").repeat(3);
// Compact JSON (the wire shape of tool schemas / tool inputs) — pretty-printed
// JSON legitimately tokenizes near prose density because indent runs are cheap.
const JSON_SAMPLE = JSON.stringify({ tools: [{ name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }], usage: { inputTokens: 1234 } });
const CJK = "継続的な検証はすべての編集の後に最も狭い意味のあるチェックを実行します。".repeat(4);
const EMOJI = "🚀🔥📊🐛⚡".repeat(10);
const BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".repeat(4);

// Code points, not UTF-16 units: an emoji is one character for pricing purposes.
const charsPerToken = (text) => [...text].length / estimateTextTokens(text);

test("ordering: code/JSON > prose per char; CJK/emoji >> ASCII; base64 denser than code", () => {
  const prose = charsPerToken(PROSE);
  const code = charsPerToken(CODE);
  const json = charsPerToken(JSON_SAMPLE);
  const cjk = charsPerToken(CJK);
  const emoji = charsPerToken(EMOJI);
  const b64 = charsPerToken(BASE64);
  assert.ok(prose > code, `prose ${prose.toFixed(2)} chars/token should exceed code ${code.toFixed(2)}`);
  assert.ok(prose > json, `prose ${prose.toFixed(2)} should exceed JSON ${json.toFixed(2)}`);
  assert.ok(cjk <= 1.05, `CJK ≈ 1 token per char, got ${cjk.toFixed(2)} chars/token`);
  assert.ok(prose / cjk >= 3, "CJK is at least 3× denser than ASCII prose");
  assert.ok(emoji <= 1.1, `emoji ≈ 1 token per code point, got ${emoji.toFixed(2)}`);
  assert.ok(b64 < code && b64 >= 2.3 && b64 <= 2.7, `base64 ≈ 2.5 chars/token and denser than code; got ${b64.toFixed(2)} vs code ${code.toFixed(2)}`);
  assert.ok(prose >= 3.7 && prose <= 4.3, `prose ≈ 4 chars/token, got ${prose.toFixed(2)}`);
  assert.ok(code >= 2.8 && code <= 3.4, `code ≈ 3 chars/token, got ${code.toFixed(2)}`);
});

test("indent runs are cheap; whitespace-only and empty text are near-free", () => {
  const flat = "return computeBlockTokens(b);";
  const indented = "        " + flat; // 8 spaces ≈ 1 token, not 2
  assert.ok(estimateLineTokens(indented) - estimateLineTokens(flat) <= 1.01);
  assert.equal(estimateTextTokens(""), 0);
  assert.ok(estimateTextTokens("\n\n\n") <= 2);
  assert.equal(estimateTextTokens("x"), 1, "non-empty text is never 0 tokens");
});

test("a mixed English + code sample lands between 3 and 4.5 chars/token", () => {
  const mixed = `${PROSE}\n\n${CODE}\n\n${JSON_SAMPLE}\n\n${PROSE}`;
  const cpt = charsPerToken(mixed);
  assert.ok(cpt >= 3 && cpt <= 4.5, `mixed sample ${cpt.toFixed(2)} chars/token`);
});

// ── images ──

function pngBase64(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

function jpegBase64(width, height) {
  // SOI, APP0 (16 bytes), SOF0 with the dimensions, then filler.
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff; app0[1] = 0xe0; app0.writeUInt16BE(16, 2); app0.write("JFIF\0", 4, "ascii");
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(32)]).toString("base64");
}

function gifBase64(width, height) {
  const buf = Buffer.alloc(32);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf.toString("base64");
}

test("image dimensions are read from PNG / JPEG / GIF headers", () => {
  assert.deepEqual(imageDimensionsFromBase64(pngBase64(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(imageDimensionsFromBase64(jpegBase64(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageDimensionsFromBase64(gifBase64(300, 200)), { width: 300, height: 200 });
  assert.equal(imageDimensionsFromBase64(Buffer.alloc(64, 7).toString("base64")), null, "unknown format → null");
});

test("image tokens: pixel area / 750 capped at 1600 when known, size-scaled guess otherwise", () => {
  const known = (w, h) => estimateImageTokens({ kind: "base64", mediaType: "image/png", data: pngBase64(w, h) });
  assert.equal(known(750, 100), 100);
  assert.equal(known(1000, 1000), Math.ceil(1_000_000 / 750));
  assert.equal(known(4000, 3000), 1600, "downscaled past the cap");
  assert.equal(known(1568, 1568), 1600);
  // Unknown format: the legacy floor/cap behaviour survives.
  const opaque = Buffer.alloc(900 * 300, 1).toString("base64");
  assert.equal(estimateImageTokens({ kind: "base64", mediaType: "image/bmp", data: opaque }), 300);
  assert.equal(estimateImageTokens({ kind: "base64", mediaType: "image/bmp", data: Buffer.alloc(64, 1).toString("base64") }), 256, "floor");
  assert.equal(estimateImageTokens({ kind: "url", url: "https://x/y.png" }), 256, "url image → floor");
  assert.equal(base64DecodedBytes(Buffer.alloc(10).toString("base64")), 10);
});
