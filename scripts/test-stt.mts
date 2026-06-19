import { textToVoice } from "../packages/channels/src/telegram/edgeTts.ts";

console.log("Generating audio...");
const audio = await textToVoice("Hello, this is a test of speech recognition.");
console.log(`Audio: ${audio.length} bytes`);

// Google's public Chromium built-in speech API key is a well-known constant, but
// it still trips secret scanners, so it's not committed — pass it via env.
const CHROMIUM_KEY = process.env.GOOGLE_SPEECH_KEY ?? "";

// v2 recognize endpoint (used by Chrome's Web Speech API)
try {
  const url = `https://www.google.com/speech-api/v2/recognize?output=json&lang=en-us&key=${CHROMIUM_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "audio/webm; codecs=opus" },
    body: audio,
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`Google v2: ${res.status}`);
  const text = await res.text();
  console.log(`Response: ${text.slice(0, 500)}`);
} catch (e: any) {
  console.log(`Google v2: ${e.message}`);
}

// Try Cloud Speech-to-Text v1
try {
  const url = `https://speech.googleapis.com/v1/speech:recognize?key=${CHROMIUM_KEY}`;
  const base64Audio = audio.toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: {
        encoding: "WEBM_OPUS",
        sampleRateHertz: 24000,
        languageCode: "en-US",
      },
      audio: { content: base64Audio },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`Google Cloud STT: ${res.status}`);
  const text = await res.text();
  console.log(`Response: ${text.slice(0, 500)}`);
} catch (e: any) {
  console.log(`Google Cloud STT: ${e.message}`);
}

process.exit(0);
