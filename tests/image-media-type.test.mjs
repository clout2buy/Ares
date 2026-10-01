// The bytes outrank the sender's claim about an image's format.
//
// Real failure this file exists for: on 2026-10-01 the iOS app labelled a JPEG
// screenshot `image/png`. Anthropic rejected the whole request — "The image was
// specified using the image/png media type, but the image appears to be a
// image/jpeg image" — and because the block was already persisted in that
// thread's history, EVERY later turn in that thread died the same way. Three
// turns did, including the first heartbeat alert. Correcting the label on the
// way to the wire is what lets a stored bad block heal.

import test from "node:test";
import assert from "node:assert/strict";

import { buildMessagesBody } from "../packages/core/dist/providers/anthropic.js";
import { imageMediaTypeFor, sniffImageMediaType } from "../packages/core/dist/providers/imageMediaType.js";

// Real format headers, so the sniffer is exercised against actual signatures
// rather than fixtures invented to match the implementation.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString("base64");
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]).toString("base64");
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]).toString("base64");

test("the sniffer reads the format out of the bytes", () => {
  assert.equal(sniffImageMediaType(JPEG), "image/jpeg");
  assert.equal(sniffImageMediaType(PNG), "image/png");
  assert.equal(sniffImageMediaType(GIF), "image/gif");
  assert.equal(sniffImageMediaType(WEBP), "image/webp");
  assert.equal(sniffImageMediaType("bm90IGFuIGltYWdl at all"), undefined, "unrecognised bytes stay unrecognised");
  assert.equal(sniffImageMediaType(""), undefined);
});

test("a claim that contradicts the bytes is corrected; a claim that matches is left alone", () => {
  assert.equal(imageMediaTypeFor("image/png", JPEG), "image/jpeg", "the lie that bricked the thread");
  assert.equal(imageMediaTypeFor("image/png", PNG), "image/png");
  assert.equal(
    imageMediaTypeFor("image/tiff", GIF),
    "image/gif",
    "even a format the API doesn't accept gets told the truth",
  );
  assert.equal(
    imageMediaTypeFor("image/avif", "AAAA"),
    "image/avif",
    "an unrecognised format keeps its claim — guessing would be worse than passing it through",
  );
});

test("buildMessagesBody sends the sniffed media_type, so a stored bad block heals", () => {
  const body = buildMessagesBody({
    model: "claude-fable-5",
    system: "you are a daemon",
    tools: [],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "U gotta do Claude rc with this chat" },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: JPEG } },
        ],
      },
    ],
  });

  const content = body.messages[0].content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image");
  assert.deepEqual(content[1].source, { type: "base64", media_type: "image/jpeg", data: JPEG });
});

test("a genuine PNG is untouched on the wire", () => {
  const body = buildMessagesBody({
    model: "claude-fable-5",
    tools: [],
    messages: [
      { role: "user", content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: PNG } }] },
    ],
  });
  assert.equal(body.messages[0].content[0].source.media_type, "image/png");
});
